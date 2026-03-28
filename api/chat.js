var https = require('https');

// ===== HTTP =====
function httpRequest(url, options, postData) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function verifyToken(token) {
  var res = await httpRequest(process.env.SUPABASE_URL + '/auth/v1/user', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_ANON_KEY }
  });
  return (res.status === 200 && res.data && res.data.id) ? res.data : null;
}

async function supabaseRPC(fn, params) {
  var res = await httpRequest(process.env.SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
  }, JSON.stringify(params));
  return res.data;
}

async function supabaseGet(table, query) {
  var res = await httpRequest(process.env.SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
    method: 'GET',
    headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY }
  });
  return res.data;
}

async function supabaseUpsert(table, data) {
  var res = await httpRequest(process.env.SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'resolution=merge-duplicates'
    }
  }, JSON.stringify(data));
  return res.data;
}

// Call Claude with 1 retry
async function callClaude(body) {
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var data = JSON.stringify(body);
      var result = await new Promise(function(resolve, reject) {
        var req = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(data) }
        }, function(res) {
          var b = '';
          res.on('data', function(c) { b += c; });
          res.on('end', function() {
            try {
              var p = JSON.parse(b);
              if (res.statusCode === 200) resolve(p);
              else reject(new Error(p.error?.message || 'API ' + res.statusCode));
            } catch (e) { reject(new Error('Parse error')); }
          });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      return result;
    } catch (err) {
      if (attempt === 0 && (err.message.indexOf('529') !== -1 || err.message.indexOf('overloaded') !== -1)) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        continue;
      }
      throw err;
    }
  }
}

// ===== CORS =====
var ALLOWED = ['https://neyrosheff.ru', 'https://www.neyrosheff.ru', 'http://localhost:3000'];
function corsOrigin(o) { return ALLOWED.indexOf(o) !== -1 ? o : ALLOWED[0]; }

// ===== HANDLER =====
module.exports = async function handler(req, res) {
  var origin = corsOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Сервер не настроен' });
  }

  var cl = parseInt(req.headers['content-length'] || '0');
  if (cl > 5 * 1024 * 1024) return res.status(413).json({ error: 'Файл слишком большой (макс 5 МБ)' });

  var authH = req.headers.authorization;
  if (!authH || authH.indexOf('Bearer ') !== 0) return res.status(401).json({ error: 'Необходима авторизация' });

  var user;
  try { user = await verifyToken(authH.slice(7)); } catch (e) { return res.status(401).json({ error: 'Ошибка авторизации' }); }
  if (!user) return res.status(401).json({ error: 'Сессия истекла. Обнови страницу.' });
  var userId = user.id;

  try {
    var body = req.body || {};
    var message = body.message;
    var sphere = body.sphere || 'general';
    var history = body.history;
    var imageBase64 = body.imageBase64;
    if (!message && !imageBase64) return res.status(400).json({ error: 'Пустое сообщение' });

    // --- Rate limit with first 3 days bonus ---
    var isEmergency = (sphere === 'emergency');
    if (!isEmergency) {
      try {
        var limitResult = await supabaseRPC('increment_daily_requests', { p_user_id: userId });
        if (limitResult && limitResult.allowed === false) {
          return res.status(429).json({
            error: 'Запросы на сегодня закончились (' + limitResult.max + '/' + limitResult.max + '). Завтра будут новые! А кнопка 🆘 работает всегда.',
            count: limitResult.count, max: limitResult.max
          });
        }
      } catch (e) { console.error('Rate limit err:', e.message); }
    }

    // --- Profile & memory ---
    var profile = null, memory = '';
    try {
      var profiles = await supabaseGet('user_profiles', 'user_id=eq.' + userId);
      if (Array.isArray(profiles) && profiles.length > 0) profile = profiles[0];
      var memories = await supabaseGet('friend_memory', 'user_id=eq.' + userId);
      if (Array.isArray(memories) && memories.length > 0) memory = memories[0].facts || '';
    } catch (e) {}

    var friendName = (profile && profile.friend_name) || 'Друг';
    var friendGender = (profile && profile.friend_gender) || 'neutral';
    var friendCharacter = (profile && profile.friend_character) || 'warm';
    var userGoals = (profile && profile.user_goals) || [];

    // --- System prompt (natural tone, no "лучший в мире") ---
    var charTraits = {
      warm: 'Ты тёплый и заботливый. Поддерживаешь, слушаешь, используешь мягкие формулировки. Как лучшая подруга/друг — надёжный и эмпатичный.',
      direct: 'Ты чёткий и мотивирующий. Говоришь правду, даёшь конкретные шаги. Как тренер который верит в человека.',
      funny: 'Ты весёлый и с юмором. Даже сложное делаешь лёгким. Шутишь уместно, поднимаешь настроение.',
      wise: 'Ты мудрый и спокойный. Задаёшь глубокие вопросы, используешь метафоры. Говоришь размеренно.'
    };
    var genderCtx = {
      female: 'Ты подруга — используешь женский род о себе.',
      male: 'Ты друг — используешь мужской род о себе.',
      neutral: 'Используешь нейтральные формулировки, без гендерных маркеров.'
    };
    var spherePrompts = {
      health: 'Сейчас ты помогаешь со здоровьем и питанием. Хорошо разбираешься в нутрициологии и фитнесе, говоришь просто и без занудства. Если прислали фото еды — подробно анализируй калории и состав. Важно: ты не врач, твои советы не заменяют консультацию специалиста.',
      career: 'Сейчас ты помогаешь с карьерой и бизнесом. Разбираешься в стратегии роста, помогаешь находить точки роста и преодолевать блоки.',
      finance: 'Сейчас ты помогаешь с финансами. Разбираешься в личных финансах и инвестициях, любишь принципы из «Самого богатого человека в Вавилоне». Важно: ты не финансовый консультант, решения за пользователем.',
      growth: 'Сейчас ты помогаешь с саморазвитием. Разбираешься в психологии, привычках и трансформации. Помогаешь расти.',
      social: 'Сейчас ты помогаешь разобраться в отношениях с людьми и окружением.',
      family: 'Сейчас ты помогаешь с семьёй и близкими отношениями. Разбираешься в психологии семьи.',
      leisure: 'Сейчас ты помогаешь с отдыхом. Знаешь как восстанавливаться, находить хобби и новые впечатления.',
      self: 'Сейчас ты помогаешь с эмоциями и внутренним состоянием. Можешь провести дыхательную технику, заземление, помочь с тревогой. Если серьёзные психологические проблемы — мягко предложи обратиться к специалисту.',
      general: '',
      emergency: ''
    };

    var style = charTraits[friendCharacter] || charTraits.warm;
    var gender = genderCtx[friendGender] || genderCtx.neutral;
    var sText = spherePrompts[sphere] || '';
    var goalMap = { food: 'питание', goals: 'цели', money: 'финансы', focus: 'фокус', talk: 'общение' };
    var goalsText = userGoals.map(function(g) { return goalMap[g] || g; }).join(', ');

    var sp = 'Ты — ' + friendName + ', персональный ИИ-компаньон. ' + gender + '\n\n' + style;
    if (sText) sp += '\n\n' + sText;
    sp += '\n\nПравила:\n- Твоё имя: ' + friendName + '. Не называй себя Claude.\n- Честно скажи что ты ИИ если спросят, но не акцентируй.\n- Отвечай на русском.\n- Кратко (2-4 предложения), длиннее если тема требует.\n- Пиши как в мессенджере, без заголовков и маркдауна.\n- Эмодзи умеренно и уместно.\n- Никогда не говори «я чувствую» или «мне грустно» — ты ИИ.\n- Не ставь медицинских диагнозов.\n- Финальное решение всегда за пользователем.';
    if (goalsText) sp += '\nВажно для пользователя: ' + goalsText + '.';
    if (memory) sp += '\n\nЧто ты помнишь о пользователе:\n' + memory;
    if (isEmergency) sp += '\n\nПОЛЬЗОВАТЕЛЮ ПЛОХО. Будь максимально тёплым и поддерживающим. Помоги успокоиться — предложи дыхание (вдох 4 сек, пауза 4, выдох 4) или заземление (5 вещей которые видишь...). Если ситуация серьёзная — мягко предложи обратиться к специалисту или на линию помощи.';

    // --- Messages ---
    var msgs = [];
    if (history && Array.isArray(history)) {
      var recent = history.slice(-10);
      for (var i = 0; i < recent.length; i++) {
        var t = recent[i].text || '';
        if (t) msgs.push({ role: recent[i].role === 'friend' ? 'assistant' : 'user', content: t });
      }
    }
    if (imageBase64) {
      msgs.push({ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: message || 'Посмотри фото' }
      ]});
    } else {
      msgs.push({ role: 'user', content: message });
    }

    // --- Call Claude ---
    var result = await callClaude({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: sp, messages: msgs });
    var reply = (result.content && result.content[0] && result.content[0].text) || 'Прости, не смог ответить.';

    // --- Memory: update every 10 messages, not every time ---
    var msgCount = (profile && profile.message_count) || 0;
    msgCount++;
    try {
      await supabaseUpsert('user_profiles', { user_id: userId, message_count: msgCount, updated_at: new Date().toISOString() });
    } catch(e) {}

    if (msgCount % 10 === 0) {
      updateMemory(userId, history, memory).catch(function(e) { console.error('Memory err:', e.message); });
    }

    // --- Count ---
    var countInfo = { count: 0, max: 10 };
    try { countInfo = await supabaseRPC('get_daily_count', { p_user_id: userId }); } catch (e) {}

    return res.status(200).json({ reply: reply, count: countInfo.count || 0, max: countInfo.max || 10 });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Что-то пошло не так. Попробуй ещё раз через пару секунд.' });
  }
};

// ===== MEMORY: extract facts from last 10 messages =====
async function updateMemory(userId, history, existingMemory) {
  if (!history || !Array.isArray(history)) return;
  var userMsgs = history.filter(function(m) { return m.role === 'user' && m.text; }).map(function(m) { return m.text; });
  if (userMsgs.length === 0) return;

  var combined = userMsgs.slice(-5).join('\n');
  var prompt = 'Вот последние сообщения пользователя:\n"' + combined.slice(0, 1000) + '"\n\nУже известные факты:\n' + (existingMemory || 'Пока ничего.') + '\n\nОбнови список фактов о пользователе. Добавь новое, убери дубли. Максимум 20 строк, кратко. ТОЛЬКО список фактов.';

  var data = await callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 512,
    system: 'Извлекай ключевые факты о человеке. Отвечай только списком фактов, по одному на строку.',
    messages: [{ role: 'user', content: prompt }]
  });

  var facts = (data.content && data.content[0] && data.content[0].text) || '';
  if (facts.length > 10) {
    await supabaseUpsert('friend_memory', { user_id: userId, facts: facts.slice(0, 2000), updated_at: new Date().toISOString() });
  }
}
