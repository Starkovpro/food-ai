var https = require('https');

// ===== TELEGRAM API =====
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

// Supabase helper
function sbRequest(path, method, body) {
  var data = body ? JSON.stringify(body) : null;
  return new Promise(function(resolve, reject) {
    var parsed = new URL(process.env.SUPABASE_URL + path);
    var opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: method || 'GET',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json'
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    var req = https.request(opts, function(res) {
      var b = '';
      res.on('data', function(c) { b += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(b)); } catch(e) { resolve(b); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ===== WEBHOOK HANDLER =====
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    // Setup webhook URL — call once: /api/telegram?setup=1
    if (req.query && req.query.setup === '1') {
      var webhookUrl = 'https://neyrosheff.ru/api/telegram';
      var result = await tgSend('setWebhook', { url: webhookUrl });
      return res.status(200).json({ webhook: result });
    }
    return res.status(200).json({ status: 'Telegram bot active' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    var update = req.body;
    if (!update || !update.message) return res.status(200).end();

    var msg = update.message;
    var chatId = msg.chat.id;
    var text = (msg.text || '').trim();
    var tgUser = msg.from;
    var firstName = tgUser.first_name || 'Друг';

    // /start command
    if (text.startsWith('/start')) {
      var refCode = text.split(' ')[1] || '';

      // Save telegram chat_id to user_profiles (link via referral code)
      if (refCode && refCode !== 'new') {
        try {
          // Find user by referral code and save their telegram_chat_id
          var profiles = await sbRequest('/rest/v1/user_profiles?referral_code=eq.' + refCode, 'GET');
          if (Array.isArray(profiles) && profiles.length > 0) {
            await sbRequest('/rest/v1/user_profiles?referral_code=eq.' + refCode, 'PATCH', {
              telegram_chat_id: String(chatId)
            });
          }
        } catch(e) { console.error('Link TG error:', e.message); }
      }

      // Also try to link by saving chat_id for later matching
      try {
        // Store telegram mapping for later
        await sbRequest('/rest/v1/telegram_users', 'POST', {
          telegram_chat_id: String(chatId),
          telegram_username: tgUser.username || '',
          telegram_first_name: firstName,
          referral_code: refCode || null,
          push_enabled: true
        });
      } catch(e) {} // May fail on duplicate, that's ok

      // Welcome message
      await tgSend('sendMessage', {
        chat_id: chatId,
        text: '👋 Привет, ' + firstName + '!\n\nЯ бот «Твой Лучший Друг». Каждое утро я буду присылать тебе доброе приветствие и напоминания ☀️\n\nЧтобы пообщаться с другом — заходи в приложение:\n🔗 neyrosheff.ru\n\nДо завтрашнего утра! 💛',
        parse_mode: 'HTML'
      });
    }

    // /stop command
    else if (text === '/stop') {
      try {
        await sbRequest('/rest/v1/telegram_users?telegram_chat_id=eq.' + chatId, 'PATCH', { push_enabled: false });
      } catch(e) {}
      await tgSend('sendMessage', {
        chat_id: chatId,
        text: 'Хорошо, я больше не буду присылать утренние сообщения. Напиши /start если передумаешь 💛'
      });
    }

    // Any other message
    else {
      await tgSend('sendMessage', {
        chat_id: chatId,
        text: 'Я пока умею только присылать утренние приветствия 😊\n\nДля полноценного общения с другом заходи в приложение:\n🔗 neyrosheff.ru'
      });
    }

  } catch(e) {
    console.error('TG webhook error:', e);
  }

  return res.status(200).end();
};
