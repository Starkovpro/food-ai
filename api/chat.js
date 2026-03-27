const https = require('https');

// ===== HTTP HELPER =====
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
      res.on('data', function(chunk) { body += chunk; });
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

// Verify Supabase JWT
async function verifyToken(token) {
  var url = process.env.SUPABASE_URL + '/auth/v1/user';
  var res = await httpRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': process.env.SUPABASE_ANON_KEY
    }
  });
  if (res.status === 200 && res.data && res.data.id) return res.data;
  return null;
}

// Supabase RPC call
async function supabaseRPC(fnName, params) {
  var url = process.env.SUPABASE_URL + '/rest/v1/rpc/' + fnName;
  var body = JSON.stringify(params);
  var res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  }, body);
  return res.data;
}

// Supabase GET
async function supabaseGet(table, query) {
  var url = process.env.SUPABASE_URL + '/rest/v1/' + table + '?' + query;
  var res = await httpRequest(url, {
    method: 'GET',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });
  return res.data;
}

// Supabase UPSERT
async function supabaseUpsert(table, data) {
  var url = process.env.SUPABASE_URL + '/rest/v1/' + table;
  var body = JSON.stringify(data);
  var res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'resolution=merge-duplicates'
    }
  }, body);
  return res.data;
}

// Call Claude
function callClaude(body) {
  var data = JSON.stringify(body);
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(body);
          if (res.statusCode === 200) resolve(parsed);
          else reject(new Error(parsed.error?.message || 'API ' + res.statusCode));
        } catch (e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ===== CORS =====
var ALLOWED_ORIGINS = [
  'https://neyrosheff.ru',
  'https://www.neyrosheff.ru',
  'http://localhost:3000'
];

function getCorsOrigin(reqOrigin) {
  if (ALLOWED_ORIGINS.indexOf(reqOrigin) !== -1) return reqOrigin;
  return ALLOWED_ORIGINS[0];
}

// ===== MAIN HANDLER =====
module.exports = async function handler(req, res) {
  var origin = getCorsOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // --- Check env ---
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.SUPABASE_ANON_KEY) {
    console.error('Missing env:', {
      hasAPI: !!process.env.ANTHROPIC_API_KEY,
      hasSBUrl: !!process.env.SUPABASE_URL,
      hasSBService: !!process.env.SUPABASE_SERVICE_KEY,
      hasSBAnon: !!process.env.SUPABASE_ANON_KEY
    });
    return res.status(500).json({ error: 'Сервер не настроен' });
  }

  // --- Body size check (5MB) ---
  var contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Файл слишком большой (макс 5 МБ)' });
  }

  // --- Auth ---
  var authHeader = req.headers.authorization;
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }
  var token = authHeader.slice(7);

  var user;
  try {
    user = await verifyToken(token);
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: 'Ошибка авторизации' });
  }
  if (!user) {
    return res.status(401).json({ error: 'Сессия истекла. Войди заново.' });
  }
  var userId = user.id;

  try {
    var body = req.body || {};
    var message = body.message;
    var sphere = body.sphere || 'general';
    var history = body.history;
    var imageBase64 = body.imageBase64;

    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }

    // --- Server-side rate limit ---
    var isEmergency = (sphere === 'emergency');
    if (!isEmergency) {
      try {
        var limitResult = await supabaseRPC('increment_daily_requests', { p_user_id: userId });
        if (limitResult && limitResult.allowed === false) {
          return res.status(429).json({
            error: 'Запросы на сегодня закончились (' + limitResult.max + '/' + limitResult.max + '). Завтра будут новые!',
            count: limitResult.count,
            max: limitResult.max
          });
        }
      } catch (e) {
        console.error('Rate limit error:', e.message);
        // Continue if rate limit check fails — don't block user
      }
    }

    // --- Get profile & memory ---
    var profile = null;
    var memory = '';
    try {
      var profiles = await supabaseGet('user_profiles', 'user_id=eq.' + userId);
      if (Array.isArray(profiles) && profiles.length > 0) profile = profiles[0];
      var memories = await supabaseGet('friend_memory', 'user_id=eq.' + userId);
      if (Array.isArray(memories) && memories.length > 0) memory = memories[0].facts || '';
    } catch (e) {
      console.error('Profile fetch:', e.message);
    }

    var friendName = (profile && profile.friend_name) || 'Друг';
    var friendGender = (profile && profile.friend_gender) || 'neutral';
    var friendCharacter = (profile && profile.friend_character) || 'warm';
    var userGoals = (profile && profile.user_goals) || [];

    // --- System prompt ---
    var charTraits = {
      warm: 'Ты тёплый и заботливый. Всегда поддерживаешь и понимаешь. Используешь мягкие формулировки. Ты как лучшая подруга/друг — надёжный и эмпатичный.',
      direct: 'Ты чёткий и мотивирующий. Говоришь правду, помогаешь действовать. Даёшь конкретные шаги. Как тренер который верит в человека.',
      funny: 'Ты весёлый и с юмором. Даже сложное делаешь лёгким. Шутишь уместно, поднимаешь настроение но помогаешь по-настоящему.',
      wise: 'Ты мудрый и спокойный. Помогаешь найти ответы внутри себя. Задаёшь глубокие вопросы. Говоришь размеренно, как мудрый наставник.'
    };
    var genderCtx = {
      female: 'Ты подруга — используешь женский род о себе.',
      male: 'Ты друг — используешь мужской род о себе.',
      neutral: 'Ты — нейтральный друг. Избегаешь гендерных маркеров.'
    };
    var spherePrompts = {
      health: 'Сейчас ты лучший интегративный нутрициолог и фитнес-тренер мира. Сочетаешь научный подход с практикой. Говоришь просто, без занудства. Помогаешь с питанием, формой, самочувствием, красотой. Фото еды — анализируй калории подробно.',
      career: 'Сейчас ты лучший бизнес-коуч и карьерный стратег мира. Работал с топ-менеджерами. Помогаешь находить точки роста, преодолевать блоки, строить карьеру мечты.',
      finance: 'Сейчас ты лучший финансовый советник мира. Знаешь всё о личных финансах и инвестициях. Основываешься на принципах "Самого богатого человека в Вавилоне". Помогаешь с деньгами и финансовой безопасностью.',
      growth: 'Сейчас ты лучший коуч по саморазвитию и трансформации. Сочетаешь психологию, нейронауки, духовные практики. Помогаешь расти и находить смысл.',
      social: 'Сейчас ты лучший эксперт по социальным связям. Понимаешь психологию отношений, помогаешь выстраивать поддерживающее окружение.',
      family: 'Сейчас ты лучший семейный психолог мира. Помогаешь строить глубокие связи с партнёром, детьми, родителями.',
      leisure: 'Сейчас ты лучший эксперт по качеству жизни и отдыху. Помогаешь восстанавливаться, находить хобби, наполнять жизнь впечатлениями.',
      self: 'Сейчас ты лучший коуч по эмоциональному интеллекту. Помогаешь понимать эмоции, повышать энергию, жить ярко.',
      general: '',
      emergency: ''
    };

    var charStyle = charTraits[friendCharacter] || charTraits.warm;
    var genderText = genderCtx[friendGender] || genderCtx.neutral;
    var sphereText = spherePrompts[sphere] || '';
    var goalMap = { food: 'питание', goals: 'цели', money: 'финансы', focus: 'фокус', talk: 'общение' };
    var goalsText = userGoals.map(function(g) { return goalMap[g] || g; }).join(', ');

    var sysPrompt = 'Ты — ' + friendName + ', персональный ИИ-компаньон. ' + genderText + '\n\n' + charStyle;
    if (sphereText) sysPrompt += '\n\n' + sphereText;
    sysPrompt += '\n\nПравила:\n- Твоё имя: ' + friendName + '. Не называй себя Claude.\n- Честно говори что ты ИИ если спросят.\n- Отвечай на русском.\n- Кратко (2-4 предложения), больше если нужно.\n- Пиши как в мессенджере.\n- Эмодзи умеренно.\n- Не говори «я чувствую».\n- Не давай медицинских диагнозов.\n- Решение за пользователем.';
    if (goalsText) sysPrompt += '\n\nВажно для пользователя: ' + goalsText + '.';
    if (memory) sysPrompt += '\n\nЧто ты помнишь о пользователе:\n' + memory;
    if (isEmergency) sysPrompt += '\n\nПОЛЬЗОВАТЕЛЮ ПЛОХО. Максимально поддержи. Помоги успокоиться. Предложи дыхание/заземление. Если серьёзно — мягко предложи специалиста.';

    // --- Messages ---
    var msgs = [];
    if (history && Array.isArray(history)) {
      var recent = history.slice(-10);
      for (var i = 0; i < recent.length; i++) {
        var r = recent[i].role === 'friend' ? 'assistant' : 'user';
        var t = recent[i].text || '';
        if (t) msgs.push({ role: r, content: t });
      }
    }

    if (imageBase64) {
      msgs.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: message || 'Посмотри фото' }
        ]
      });
    } else {
      msgs.push({ role: 'user', content: message });
    }

    // --- Call Claude ---
    var result = await callClaude({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: sysPrompt,
      messages: msgs
    });

    var reply = (result.content && result.content[0] && result.content[0].text) || 'Прости, не смог ответить.';

    // --- Update memory async ---
    updateMemory(userId, message, memory).catch(function(e) {
      console.error('Memory err:', e.message);
    });

    // --- Get count ---
    var countInfo = { count: 0, max: 15 };
    try {
      countInfo = await supabaseRPC('get_daily_count', { p_user_id: userId });
    } catch (e) {}

    return res.status(200).json({
      reply: reply,
      count: countInfo.count || 0,
      max: countInfo.max || 15
    });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Ошибка: ' + (err.message || 'неизвестная') });
  }
};

// ===== MEMORY =====
async function updateMemory(userId, userMessage, existingMemory) {
  if (!userMessage) return;
  var keywords = ['я ', 'мне ', 'мой ', 'моя ', 'меня ', 'зовут', 'лет', 'работ', 'живу', 'люблю', 'хочу', 'цель', 'мечт', 'трево', 'семь'];
  var found = keywords.some(function(kw) { return userMessage.toLowerCase().indexOf(kw) !== -1; });
  if (!found) return;

  var prompt = 'Сообщение пользователя: "' + userMessage.slice(0, 500) + '"\n\nИзвестные факты:\n' + (existingMemory || 'Пока ничего.') + '\n\nОбнови список фактов — добавь новое, не дублируй. Максимум 20 строк. Только список, без пояснений.';

  var data = await callClaude({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: 'Извлекай ключевые факты о человеке. Отвечай только списком.',
    messages: [{ role: 'user', content: prompt }]
  });

  var facts = (data.content && data.content[0] && data.content[0].text) || '';
  if (facts.length > 10) {
    await supabaseUpsert('friend_memory', {
      user_id: userId,
      facts: facts.slice(0, 2000),
      updated_at: new Date().toISOString()
    });
  }
}
