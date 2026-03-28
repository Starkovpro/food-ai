var https = require('https');

function tgSend(method, body) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.resolve(null);
  var data = JSON.stringify(body);
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, function(res) {
      var b = '';
      res.on('data', function(c) { b += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(b)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sbGet(path) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(process.env.SUPABASE_URL + path);
    var req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
      }
    }, function(res) {
      var b = '';
      res.on('data', function(c) { b += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(b)); } catch(e) { resolve([]); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Morning greetings - different every day
var greetings = [
  'Доброе утро! ☀️ Новый день — новые возможности. Как планируешь провести его?',
  'Утро! 🌅 Не забудь позавтракать — это важно для энергии на весь день.',
  'Привет! ☀️ Сегодня отличный день чтобы сделать шаг к своей цели. Даже маленький.',
  'Доброе утро! 🌞 Помни — ты молодец уже потому что встала и идёшь вперёд.',
  'Утречко! ☀️ Совет дня: выпей стакан воды прямо сейчас 💧',
  'Доброе утро! 🌤 Загляни ко мне сегодня — поговорим, как дела.',
  'Привет! ☀️ Что если сегодня сфотографировать обед и узнать калории? 📸',
  'Утро! 🌅 Знаешь, что 10 минут дыхательной практики = перезагрузка мозга? Попробуем?',
  'Доброе утро! ☀️ Не забудь — маленькие шаги каждый день важнее больших рывков раз в месяц.',
  'Привет! 🌞 Сегодня хороший день чтобы навести порядок в финансах. Или просто поболтать 😊',
  'Утро! ☀️ Факт дня: те кто записывают свои цели — достигают их в 2 раза чаще.',
  'Доброе утро! 🌤 Ты давно заполняла колесо баланса? Загляни — может что-то изменилось!',
  'Привет! ☀️ Помни: отдых — это не лень, а инвестиция в себя.',
  'Утро! 🌅 Попробуй сегодня технику 5-4-3-2-1 если станет тревожно. Я помогу!',
  'Доброе утро! ☀️ Ты уже 🔥 день подряд со мной — так держать!'
];

module.exports = async function handler(req, res) {
  // Verify cron secret (prevent random calls)
  var cronSecret = req.headers['authorization'];
  if (cronSecret !== 'Bearer ' + process.env.CRON_SECRET && req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.SUPABASE_URL) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    // Get all users with push enabled
    var users = await sbGet('/rest/v1/telegram_users?push_enabled=eq.true&select=telegram_chat_id,telegram_first_name');

    if (!Array.isArray(users) || users.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No subscribers' });
    }

    var today = new Date();
    var dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / (1000*60*60*24));
    var greeting = greetings[dayOfYear % greetings.length];

    var sent = 0;
    var errors = 0;

    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      var personalGreeting = greeting.replace(/ты /gi, function(m) { return m; }); // Keep as is
      try {
        var result = await tgSend('sendMessage', {
          chat_id: user.telegram_chat_id,
          text: personalGreeting + '\n\n🔗 neyrosheff.ru'
        });
        if (result && result.ok) sent++;
        else errors++;
      } catch(e) {
        errors++;
      }
      // Small delay to avoid Telegram rate limit
      if (i < users.length - 1) {
        await new Promise(function(r) { setTimeout(r, 100); });
      }
    }

    return res.status(200).json({ sent: sent, errors: errors, total: users.length });

  } catch(e) {
    console.error('Morning cron error:', e);
    return res.status(500).json({ error: e.message });
  }
};
