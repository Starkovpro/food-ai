export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { type, imageBase64, ingredients, weight } = req.body;

  let messages;

  if (type === 'calories') {
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const weightNote = weight ? `Вес блюда указан пользователем: ${weight} граммов. Используй эти данные для точного расчёта калорий.` : 'Вес блюда не указан — оцени порцию визуально.';

    messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
        },
        {
          type: 'text',
          text: `Ты диетолог и нутрициолог. Внимательно посмотри на фото и определи что за блюдо или продукты изображены. ${weightNote}\n\nЗатем:\n1. Назови блюдо/продукты\n2. Рассчитай калорийность (ккал)${weight ? ` для ${weight}г` : ' для порции на фото'}\n3. Укажи содержание белков, жиров и углеводов\n4. Дай краткую заметку о пищевой ценности\n\nЕсли на фото нет еды, скажи об этом.\n\nФормат: начни ответ с числа калорий вот так: ККАЛ: [число], затем с новой строки дай полный анализ.`
        }
      ]
    }];
  } else if (type === 'recipe') {
    if (!ingredients) return res.status(400).json({ error: 'No ingredients provided' });

    messages = [{
      role: 'user',
      content: `Ты опытный шеф-повар. У меня есть следующие продукты: ${ingredients}\n\nПредложи одно конкретное блюдо, которое можно приготовить из этих продуктов. Дай подробный рецепт:\n\n1. Название блюда\n2. Время приготовления\n3. Ингредиенты с количеством (только из моего списка)\n4. Пошаговый рецепт (5-8 шагов)\n5. Совет по подаче\n\nПиши чётко, по-русски, без лишних слов.`
    }];
  } else {
    return res.status(400).json({ error: 'Invalid type' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    const text = data.content?.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ text });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
