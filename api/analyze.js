export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { type, imageBase64, ingredients, weight } = req.body;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  const callClaude = async (messages, max_tokens = 1000) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens, messages })
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

      const text = await callClaude([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `Ты диетолог. ${weightNote}\n\nОтветь строго в формате:\n\nБЛЮДО: [название]\nККАЛ: [число]\n\nЗатем:\n1. Белки / жиры / углеводы\n2. Заметка о пищевой ценности (2-3 предложения)\n\nЕсли на фото нет еды — напиши об этом.` }
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

      const text = await callClaude([{
        role: 'user',
        content: `Ты шеф-повар. Продукты: ${ingredients}\n\nПредложи одно блюдо и дай рецепт:\n1. Название\n2. Время приготовления\n3. Ингредиенты с количеством\n4. Пошаговый рецепт (5-8 шагов)\n5. Совет по подаче\n\nПиши чётко, по-русски.`
      }]);

      return res.status(200).json({ text });

    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
