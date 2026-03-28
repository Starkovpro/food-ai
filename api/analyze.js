export default async function handler(req, res) {
  // 1. Method check first
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const token = authHeader.split(' ')[1];
  const SUPABASE_URL = 'https://siwibqrykqlyxiwtukst.supabase.co';
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;

  const supabaseRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': ANON_KEY
    }
  });

  if (!supabaseRes.ok) {
    return res.status(401).json({ error: 'Сессия истекла, войдите снова' });
  }

  const userData = await supabaseRes.json();

  // 3. Trial period check (3 days)
  const registeredAt = new Date(userData.created_at);
  const now = new Date();
  const daysPassed = Math.floor((now - registeredAt) / (1000 * 60 * 60 * 24));

  if (daysPassed >= 3) {
    return res.status(403).json({ error: 'trial_expired' });
  }

  // 4. API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { type, imageBase64, ingredients, weight, dishName, portions } = req.body;

  // 5. Image size limit (max 2MB base64)
  if (imageBase64 && imageBase64.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Изображение слишком большое, максимум 2MB' });
  }

  // 6. Input length limits
  if (ingredients && ingredients.length > 1000) {
    return res.status(400).json({ error: 'Слишком длинный список продуктов' });
  }
  if (dishName && dishName.length > 100) {
    return res.status(400).json({ error: 'Слишком длинное название блюда' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  const callClaude = async (messages, max_tokens = 1000) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, messages })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Ошибка API');
    return d.content?.find(b => b.type === 'text')?.text || '';
  };

  try {
    if (type === 'calories') {
      if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

      const weightNote = weight
        ? `Вес блюда: ${weight} граммов — используй для точного расчёта.`
        : 'Вес не указан — оцени визуально.';
      const dishNote = dishName ? `Пользователь уточняет: это "${dishName}". Используй это для точного расчёта.` : '';

      const text = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `Ты диетолог. ${weightNote} ${dishNote}\n\nОтветь строго в формате:\n\nБЛЮДО: [название]\nККАЛ: [число]\n\nЗатем:\n1. Белки / жиры / углеводы\n2. Заметка о пищевой ценности (2-3 предложения)\n\nЕсли на фото нет еды — напиши об этом.` }
        ]
      }]);

      const dishMatch = text.match(/БЛЮДО:\s*([^\n]+)/i);
      const kcalMatch = text.match(/ККАЛ:\s*(\d+)/i);
      const dish = dishMatch ? dishMatch[1].trim() : 'это блюдо';
      const kcal = kcalMatch ? kcalMatch[1] : null;

      const tip = await callClaude([{
        role: 'user',
        content: `Ты тренер женского фитнес-клуба, говоришь как заботливая подружка — тепло и по делу. Девушка съела: ${dish}${kcal ? `, около ${kcal} ккал` : ''}. Напиши совет в 2-3 предложения: можно ли до/после тренировки, как это вписывается в здоровое питание, и доброе слово. Без заголовков, просто текст.`
      }], 200);

      return res.status(200).json({ text, tip });

    } else if (type === 'recipe') {
      if (!ingredients) return res.status(400).json({ error: 'No ingredients provided' });

      const servings = portions || 1;
      const text = await callClaude([{
        role: 'user',
        content: `Ты шеф-повар. Продукты: ${ingredients}\n\nПриготовь рецепт строго на ${servings} ${servings === 1 ? 'порцию' : servings < 5 ? 'порции' : 'порций'}. Рассчитай количество ингредиентов точно под это число порций — не больше и не меньше.\n\nДай рецепт:\n1. Название блюда\n2. Время приготовления\n3. Ингредиенты с точным количеством на ${servings} ${servings === 1 ? 'порцию' : servings < 5 ? 'порции' : 'порций'}\n4. Пошаговый рецепт (5-8 шагов)\n5. Совет по подаче\n\nПиши чётко, по-русски.`
      }]);

      return res.status(200).json({ text });

    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
