export default async function handler(req, res) {
  // Check auth token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  // Verify token with Supabase
  const token = authHeader.split(' ')[1];
  const supabaseRes = await fetch('https://siwibqrykqlyxiwtukst.supabase.co/auth/v1/user', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpd2licXJ5a3FseXhpd3R1a3N0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNzMwODEsImV4cCI6MjA4OTY0OTA4MX0.hACYQJs1Il0IykGGvbJKisFxvSYukHB0a3Mtnh2I-T4'
    }
  });

  if (!supabaseRes.ok) {
    return res.status(401).json({ error: 'Сессия истекла, войдите снова' });
  }

  const userData = await supabaseRes.json();

  // Check trial period (7 days)
  const registeredAt = new Date(userData.created_at);
  const now = new Date();
  const daysPassed = Math.floor((now - registeredAt) / (1000 * 60 * 60 * 24));

  if (daysPassed >= 7) {
    return res.status(403).json({ error: 'trial_expired' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { type, imageBase64, ingredients, weight, dishName, portions } = req.body;

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
