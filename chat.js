const https = require('https');

function callClaude(apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200) resolve(parsed);
          else reject(new Error(parsed.error?.message || 'API ' + res.statusCode + ': ' + body.slice(0, 200)));
        } catch (e) {
          reject(new Error('JSON parse error: ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — тест что функция работает
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'Chat API работает!',
      hasKey: !!process.env.ANTHROPIC_API_KEY
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, friendName, friendGender, friendCharacter, userGoals, sphere, history, imageBase64 } = req.body || {};

    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'API ключ не настроен на сервере' });
    }

    // --- Build system prompt ---
    const characterTraits = {
      warm: 'Ты тёплый и заботливый. Всегда поддерживаешь и понимаешь. Используешь мягкие формулировки, часто спрашиваешь как дела. Ты как лучшая подруга/друг — надёжный и эмпатичный.',
      direct: 'Ты чёткий и мотивирующий. Говоришь правду, помогаешь действовать. Даёшь конкретные шаги. Уважительно и с заботой. Ты как тренер который верит в человека.',
      funny: 'Ты весёлый и с юмором. Даже сложное делаешь лёгким. Шутишь уместно, поднимаешь настроение но помогаешь по-настоящему.',
      wise: 'Ты мудрый и спокойный. Помогаешь найти ответы внутри себя. Задаёшь глубокие вопросы, используешь метафоры. Говоришь размеренно, как мудрый наставник.'
    };

    const genderContext = {
      female: 'Ты подруга — используешь женский род о себе.',
      male: 'Ты друг — используешь мужской род о себе.',
      neutral: 'Ты — нейтральный друг. Избегаешь гендерных маркеров о себе.'
    };

    const spherePrompts = {
      health: 'Сейчас ты выступаешь как лучший интегративный нутрициолог и фитнес-тренер мира. Сочетаешь научный подход с практикой. Говоришь просто, без занудства. Помогаешь с питанием, физической формой, самочувствием и красотой. Если пользователь отправляет фото еды — анализируй калории и состав.',
      career: 'Сейчас ты выступаешь как лучший бизнес-коуч и карьерный стратег мира. Работал с топ-менеджерами и предпринимателями. Помогаешь находить точки роста, преодолевать блоки и строить карьеру мечты.',
      finance: 'Сейчас ты выступаешь как лучший финансовый советник мира. Знаешь всё о личных финансах, инвестициях и финансовой психологии. Основываешься на принципах книги "Самый богатый человек в Вавилоне". Помогаешь выстраивать отношения с деньгами и строить финансовую безопасность.',
      growth: 'Сейчас ты выступаешь как лучший коуч по саморазвитию и трансформации личности. Сочетаешь психологию, нейронауки и духовные практики. Помогаешь учиться, расти и находить смысл.',
      social: 'Сейчас ты выступаешь как лучший эксперт по социальным связям и коммуникациям. Понимаешь психологию отношений и помогаешь выстраивать поддерживающее окружение.',
      family: 'Сейчас ты выступаешь как лучший семейный психолог и эксперт по близким отношениям мира. Помогаешь строить глубокие связи с партнёром, детьми и родителями.',
      leisure: 'Сейчас ты выступаешь как лучший эксперт по качеству жизни и осознанному отдыху. Знаешь как восстанавливаться, находить хобби и наполнять жизнь яркими впечатлениями.',
      self: 'Сейчас ты выступаешь как лучший коуч по эмоциональному интеллекту и личной эффективности. Помогаешь понимать свои эмоции, повышать энергию и жить ярко.',
      general: '',
      emergency: ''
    };

    const name = friendName || 'Друг';
    const charStyle = characterTraits[friendCharacter] || characterTraits.warm;
    const gender = genderContext[friendGender] || genderContext.neutral;
    const sphereText = spherePrompts[sphere] || '';

    const goalNames = {
      food: 'питание и здоровье',
      goals: 'достижение целей',
      money: 'деньги и финансы',
      focus: 'спокойствие и фокус',
      talk: 'просто поговорить'
    };
    const goals = (userGoals || []).map(function(g) { return goalNames[g] || g; }).join(', ');

    var systemPrompt = 'Ты — ' + name + ', персональный ИИ-компаньон. ' + gender + '\n\n' + charStyle + '\n\n' + sphereText + '\n\nПравила:\n- Твоё имя: ' + name + '. Не называй себя Claude или AI-ассистент.\n- Честно говори что ты ИИ если спросят, но не акцентируй.\n- Отвечай на русском.\n- Будь кратким — 2-4 предложения, больше если тема требует.\n- Пиши как в мессенджере, без маркдаун-заголовков.\n- Эмодзи умеренно.\n- Не говори я чувствую или мне грустно.\n- Не давай медицинских диагнозов.\n- Финальное решение за пользователем.';

    if (goals) systemPrompt += '\n\nПользователю важно: ' + goals + '.';
    if (sphere === 'emergency') systemPrompt += '\n\nПОЛЬЗОВАТЕЛЮ ПЛОХО. Будь максимально поддерживающим и тёплым. Помоги успокоиться. Предложи дыхание или заземление. Если серьёзно — мягко предложи специалиста.';

    // --- Build messages ---
    var messages = [];
    if (history && Array.isArray(history)) {
      var recent = history.slice(-10);
      for (var i = 0; i < recent.length; i++) {
        messages.push({
          role: recent[i].role === 'friend' ? 'assistant' : 'user',
          content: recent[i].text || ''
        });
      }
    }

    if (imageBase64) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: message || 'Посмотри на это фото' }
        ]
      });
    } else {
      messages.push({ role: 'user', content: message });
    }

    var data = await callClaude(process.env.ANTHROPIC_API_KEY, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });

    var reply = (data.content && data.content[0] && data.content[0].text) || 'Прости, не смог ответить.';
    return res.status(200).json({ reply: reply });

  } catch (err) {
    console.error('Chat API error:', err);
    return res.status(500).json({ error: 'Ошибка: ' + (err.message || 'неизвестная') });
  }
};
