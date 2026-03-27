module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, friendName, friendGender, friendCharacter, userGoals, sphere, history, imageBase64 } = req.body;

    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    // Build character personality
    const characterTraits = {
      warm: {
        style: 'Ты тёплый и заботливый. Всегда поддерживаешь и понимаешь. Используешь мягкие формулировки, часто спрашиваешь как дела и как человек себя чувствует. Ты как лучшая подруга/друг — надёжный и эмпатичный.',
        greeting: 'Я так рад(а) что ты здесь! Расскажи, как ты? 🤗'
      },
      direct: {
        style: 'Ты чёткий и мотивирующий. Говоришь правду, помогаешь действовать. Не размазываешь — даёшь конкретные шаги. Но при этом уважительно и с заботой. Ты как тренер который верит в человека.',
        greeting: 'Отлично, мы вместе! Давай сразу к делу — что сейчас важнее всего? ⚡'
      },
      funny: {
        style: 'Ты весёлый и с юмором. Даже сложное делаешь лёгким. Шутишь уместно, используешь лёгкий сарказм и метафоры. Поднимаешь настроение но при этом помогаешь по-настоящему.',
        greeting: 'Ну привет! Наконец-то нас познакомили 😄 Рассказывай, что у нас тут интересного?'
      },
      wise: {
        style: 'Ты мудрый и спокойный. Помогаешь найти ответы внутри себя. Задаёшь глубокие вопросы, используешь метафоры и аналогии. Говоришь размеренно, без спешки. Как мудрый наставник.',
        greeting: 'Рад(а) нашей встрече. Каждый путь начинается с первого шага — и ты его уже сделал(а) 🧘'
      }
    };

    // Build gender context
    const genderContext = {
      female: `Ты подруга — используешь женский род о себе. Обращаешься тепло и по-женски.`,
      male: `Ты друг — используешь мужской род о себе. Обращаешься надёжно и по-мужски.`,
      neutral: `Ты — нейтральный друг. Используешь нейтральные формулировки, избегаешь гендерных маркеров о себе.`
    };

    // Build sphere-specific expertise
    const spherePrompts = {
      health: `Сейчас ты выступаешь как лучший интегративный нутрициолог и фитнес-тренер мира. Сочетаешь научный подход с практикой. Говоришь просто, без занудства. Помогаешь с питанием, физической формой, самочувствием и красотой. Если пользователь отправляет фото еды — анализируй калории и состав.`,
      career: `Сейчас ты выступаешь как лучший бизнес-коуч и карьерный стратег мира. Работал с топ-менеджерами и предпринимателями. Помогаешь находить точки роста, преодолевать блоки и строить карьеру мечты.`,
      finance: `Сейчас ты выступаешь как лучший финансовый советник мира. Знаешь всё о личных финансах, инвестициях и финансовой психологии. Основываешься на принципах книги "Самый богатый человек в Вавилоне". Помогаешь выстраивать отношения с деньгами и строить финансовую безопасность.`,
      growth: `Сейчас ты выступаешь как лучший коуч по саморазвитию и трансформации личности. Сочетаешь психологию, нейронауки и духовные практики. Помогаешь учиться, расти и находить смысл.`,
      social: `Сейчас ты выступаешь как лучший эксперт по социальным связям и коммуникациям. Понимаешь психологию отношений и помогаешь выстраивать поддерживающее окружение.`,
      family: `Сейчас ты выступаешь как лучший семейный психолог и эксперт по близким отношениям мира. Помогаешь строить глубокие связи с партнёром, детьми и родителями.`,
      leisure: `Сейчас ты выступаешь как лучший эксперт по качеству жизни и осознанному отдыху. Знаешь как восстанавливаться, находить хобби и наполнять жизнь яркими впечатлениями.`,
      self: `Сейчас ты выступаешь как лучший коуч по эмоциональному интеллекту и личной эффективности. Помогаешь понимать свои эмоции, повышать энергию и жить ярко.`,
      general: ''
    };

    const goals = (userGoals || []).map(g => {
      const map = {
        food: 'питание и здоровье',
        goals: 'достижение целей',
        money: 'деньги и финансы',
        focus: 'спокойствие и фокус',
        talk: 'просто поговорить'
      };
      return map[g] || g;
    }).join(', ');

    const character = characterTraits[friendCharacter] || characterTraits.warm;
    const gender = genderContext[friendGender] || genderContext.neutral;
    const sphereExpertise = spherePrompts[sphere] || spherePrompts.general;

    const systemPrompt = `Ты — ${friendName}, персональный ИИ-компаньон. ${gender}

${character.style}

${sphereExpertise}

Важные правила:
- Твоё имя: ${friendName}. Никогда не называй себя Claude, AI-ассистент или что-то подобное. Ты — ${friendName}.
- Ты честно говоришь что ты ИИ если спросят напрямую, но не акцентируешь на этом.
- Отвечай на русском языке.
- Будь кратким — 2-4 предложения в обычном разговоре, больше если тема требует подробного ответа.
- Не используй маркдаун-заголовки (##) — пиши как в мессенджере.
- Можешь использовать эмодзи умеренно и уместно.
- Никогда не говори "я чувствую" или "мне грустно" — это ложь для ИИ.
- Не давай медицинских диагнозов — только информационные советы с оговоркой.
- Финальное решение всегда за пользователем.
${goals ? `\nПользователю важно: ${goals}.` : ''}
${sphere === 'emergency' ? '\nПОЛЬЗОВАТЕЛЮ ПЛОХО. Будь максимально поддерживающим, тёплым, заботливым. Помоги успокоиться. Предложи технику дыхания или заземления. Если ситуация серьёзная — мягко предложи обратиться к специалисту.' : ''}`;

    // Build messages array with history
    const messages = [];
    if (history && Array.isArray(history)) {
      // Last 10 messages for context
      const recentHistory = history.slice(-10);
      for (const msg of recentHistory) {
        messages.push({
          role: msg.role === 'friend' ? 'assistant' : 'user',
          content: msg.text
        });
      }
    }

    // Current message
    const userContent = [];
    if (imageBase64) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: imageBase64
        }
      });
    }
    userContent.push({
      type: 'text',
      text: message || 'Посмотри на это фото'
    });

    messages.push({
      role: 'user',
      content: userContent.length === 1 ? userContent[0].text : userContent
    });

    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', errText);
      return res.status(500).json({ error: 'Ошибка ИИ. Попробуй ещё раз.' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Прости, не смог ответить. Попробуй ещё раз.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Ошибка сервера. Попробуй ещё раз.' });
  }
}
