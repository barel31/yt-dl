require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const { GetObjectCommand, S3 } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { processDownload, extractVideoId } = require('./download');

// --- Redis Setup ---
// In development, disable Redis caching.
let redisClient;
if (process.env.NODE_ENV === 'development') {
  console.log('Development mode – Redis caching is disabled.');
  redisClient = {
    get: async () => null,
    setEx: async () => {},
  };
} else {
  const redis = require('redis');
  redisClient = redis.createClient({
    url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`
  });
  redisClient.on('error', err => console.error('Redis error:', err));
  redisClient.connect().catch(console.error);
}

// Express setup.
const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// AWS S3 Setup.
const s3 = new S3({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

// Rate limiting and active downloads.
const rateLimitCache = {};
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 3;
function isRateLimited(chatId) {
  const now = Date.now();
  if (!rateLimitCache[chatId]) {
    rateLimitCache[chatId] = { count: 1, lastRequest: now };
    return false;
  }
  const diff = now - rateLimitCache[chatId].lastRequest;
  if (diff > RATE_LIMIT_WINDOW) {
    rateLimitCache[chatId] = { count: 1, lastRequest: now };
    return false;
  } else {
    rateLimitCache[chatId].count++;
    return rateLimitCache[chatId].count > MAX_REQUESTS_PER_WINDOW;
  }
}
const activeDownloads = {}; // keyed by chatId

// Helper to trim long messages.
const MAX_MESSAGE_LENGTH = 4096;
function trimMessage(text) {
  return text.length > MAX_MESSAGE_LENGTH
    ? text.substring(0, MAX_MESSAGE_LENGTH - 3) + '...'
    : text;
}

// Webhook Setup.
const webhookBase = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
const webhookUrl = webhookBase.endsWith('/webhook') ? webhookBase : `${webhookBase}/webhook`;
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
bot.setWebHook(webhookUrl)
  .then(() => console.log('Webhook set successfully:', webhookUrl))
  .catch(err => console.error('Error setting webhook:', err));

app.post('/webhook', (req, res) => {
  console.log('Update received:', req.body && req.body.update_id);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Optional ping endpoint.
app.get('/ping', (req, res) => {
  res.send('pong');
});

// --- Bot Message Handler ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (isRateLimited(chatId)) {
    bot.sendMessage(chatId, 'יותר מדי בקשות, אנא המתן רגע.');
    return;
  }
  if (activeDownloads[chatId]) {
    bot.sendMessage(chatId, 'יש הורדה פעילה, אנא המתן לסיום.');
    return;
  }
  if (!text || !(text.includes('youtube.com') || text.includes('youtu.be'))) {
    bot.sendMessage(chatId, 'נא לשלוח קישור YouTube תקין.');
    return;
  }
  const videoId = extractVideoId(text);
  if (!videoId) {
    bot.sendMessage(chatId, 'לא ניתן לחלץ את מזהה הווידאו. אנא נסה קישור אחר.');
    return;
  }
  // Provide inline buttons for MP3 and MP4 downloads.
  const mp3Data = JSON.stringify({ a: 'download', i: videoId, f: 'mp3' });
  const mp4Data = JSON.stringify({ a: 'select_quality', i: videoId });
  const inlineKeyboard = {
    inline_keyboard: [
      [{ text: 'הורד MP3', callback_data: mp3Data }, { text: 'הורד MP4', callback_data: mp4Data }]
    ]
  };
  bot.sendMessage(chatId, 'איך תרצה להוריד את הווידאו?', { reply_markup: inlineKeyboard });
});

// --- Callback Query Handler ---
bot.on('callback_query', async (callbackQuery) => {
  let parsed;
  try {
    parsed = JSON.parse(callbackQuery.data);
  } catch (e) {
    console.error('שגיאה בפיענוח נתוני החזרה:', e);
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'בחירה לא תקינה' });
  }
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const action = parsed.a;

  // Handle cancel-download action.
  if (action === 'cancel_download') {
    if (!activeDownloads[chatId]) {
      return bot.answerCallbackQuery(callbackQuery.id, { text: 'הורדה כבר בוטלה' });
    }
    activeDownloads[chatId] = false;
    try {
      await bot.editMessageText('הורדה בוטלה על ידי המשתמש.', { chat_id: chatId, message_id: messageId });
    } catch (e) {
      console.error('שגיאה בעדכון הודעת ביטול:', e.message);
    }
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'הורדה בוטלה' });
  }

  // Remove inline keyboard from previous message.
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.error('שגיאה בהסרת הלחצנים:', error.message);
  }

  if (action === 'cancel') {
    bot.answerCallbackQuery(callbackQuery.id, { text: 'בוטל' });
    bot.sendMessage(chatId, 'ההורדה בוטלה.');
    return;
  }

  // If user selects MP4 and needs to choose quality.
  if (action === 'select_quality' && parsed.i) {
    bot.answerCallbackQuery(callbackQuery.id, { text: 'מקבל אפשרויות איכות...' });
    try {
      const qualityUrl = `https://youtube-video-fast-downloader-24-7.p.rapidapi.com/get_available_quality/${parsed.i}`;
      const qualityResponse = await axios.request({
        method: 'GET',
        url: qualityUrl,
        headers: {
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          'x-rapidapi-host': 'youtube-video-fast-downloader-24-7.p.rapidapi.com',
        },
      });
      console.log("Quality options received:", qualityResponse.data);
      let qualities = qualityResponse.data;
      if (!Array.isArray(qualities)) {
        qualities = Object.values(qualities);
      }
      if (!Array.isArray(qualities) || qualities.length === 0) {
        console.warn("No quality options found, falling back to default quality.");
        const defaultQualityId = process.env.DEFAULT_VIDEO_QUALITY_ID || 137;
        const defaultResolution = process.env.DEFAULT_VIDEO_QUALITY_RESOLUTION || "720p";
        qualities = [{ id: defaultQualityId, quality: defaultResolution, type: 'video' }];
      }
      // Filter for video options with 'mp4' in MIME type.
      const videoQualities = qualities.filter(opt => opt.type === 'video' && opt.mime.includes('mp4'));
      if (videoQualities.length === 0) {
        throw new Error('אין אפשרויות וידאו זמינות עבור פורמט MP4');
      }
      // Deduplicate options by quality label.
      const uniqueQualitiesMap = new Map();
      videoQualities.forEach(opt => {
        if (!uniqueQualitiesMap.has(opt.quality)) {
          uniqueQualitiesMap.set(opt.quality, opt);
        }
      });
      const uniqueQualities = Array.from(uniqueQualitiesMap.values());
      
      const qualityButtons = uniqueQualities.map(opt => {
        const callbackData = JSON.stringify({ a: 'download', i: parsed.i, f: 'mp4', q: opt.id });
        return { text: opt.quality, callback_data: callbackData };
      });
      const qualityKeyboard = {
        inline_keyboard: [
          qualityButtons,
          [{ text: 'בטל', callback_data: JSON.stringify({ a: 'cancel' }) }]
        ]
      };
      await bot.editMessageText('בחר את האיכות להורדת הווידאו:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: qualityKeyboard
      });
    } catch (error) {
      console.error('Error fetching quality options:', error.message);
      bot.sendMessage(chatId, `שגיאה בקבלת אפשרויות איכות: ${error.message}`);
    }
    return;
  }
  
  // Handle download action.
  if (action === 'download' && parsed.i) {
    bot.answerCallbackQuery(callbackQuery.id, { text: 'מעבד הורדה...' });
    let progressMsg;
    try {
      progressMsg = await bot.sendMessage(chatId, 'הבקשה בעיבוד, אנא המתן...\nניתן ללחוץ על "בטל הורדה" כדי לבטל.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'בטל הורדה', callback_data: JSON.stringify({ a: 'cancel_download', i: parsed.i }) }]
          ]
        }
      });
    } catch (error) {
      console.error('Error sending initial status message:', error);
    }
    activeDownloads[chatId] = true;
    const format = parsed.f || 'mp3';
    const quality = parsed.q || null;
    const videoUrl = `https://youtu.be/${parsed.i}`;
    
    // Cancellation check.
    const cancellationCheck = () => !activeDownloads[chatId];
    
    // Update status message; if download is canceled, do not update further.
    const updateStatus = async (newStatus, disableCancel = false) => {
      if (cancellationCheck()) return; // Skip updates if canceled.
      try {
        const replyMarkup = disableCancel
          ? {}
          : { inline_keyboard: [[{ text: 'בטל הורדה', callback_data: JSON.stringify({ a: 'cancel_download', i: parsed.i }) }]] };
        await bot.editMessageText(trimMessage(newStatus), {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          reply_markup: replyMarkup
        });
      } catch (error) {
        if (!error.message.includes('message is not modified')) {
          console.error('Error updating status message:', error.message);
        }
      }
    };
    
    try {
      const result = await processDownload(videoUrl, updateStatus, format, quality, cancellationCheck);
      await updateStatus('ההורדה הושלמה. מכין את הקובץ...', true);
      
      const sanitizeFileName = name => name.trim().replace(/[^\p{L}\p{N}\-_ ]/gu, '_');
      const sanitizedTitle = sanitizeFileName(result.title) || `file_${Date.now()}`;
      const fileExtension = format === 'mp4' ? '.mp4' : '.mp3';
      const localFilePath = path.join(__dirname, `${sanitizedTitle}${fileExtension}`);
      
      async function downloadFile(url, localFilePath) {
        console.log("Attempting file download from URL:", url);
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          headers: {
            'User-Agent': `${process.env.RAPIDAPI_USERNAME} Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36`,
            'x-run': crypto.createHash('md5').update(process.env.RAPIDAPI_USERNAME).digest('hex'),
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
            'Accept': '*/*'
          },
          validateStatus: status => (status >= 200 && status < 300) || status === 404,
        });
        console.log(`Response status: ${response.status} ${response.statusText}`);
        return response;
      }
      
      let response = await downloadFile(result.link, localFilePath);
      if (response.status === 404) {
        await updateStatus('מצטער, לא נמצא הקובץ (404).', true);
        bot.sendMessage(chatId, 'מצטער, לא נמצא הקובץ (404).');
        activeDownloads[chatId] = false;
        return;
      }
      
      const writer = fs.createWriteStream(localFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      await updateStatus('מעלה את הקובץ ל-S3, אנא המתן...', true);
      const fileStream = fs.createReadStream(localFilePath);
      const s3Params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `${sanitizedTitle}${fileExtension}`,
        Body: fileStream,
        ContentType: format === 'mp4' ? 'video/mp4' : 'audio/mpeg'
      };
      await new Upload({
        client: s3,
        params: s3Params,
      }).done();
      const s3Url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `${sanitizedTitle}${fileExtension}`,
      }), {
        expiresIn: 3600,
      });
      
      await updateStatus('מעלה את הקובץ ל-Telegram, אנא המתן...', true);
      if (format === 'mp4') {
        await bot.sendVideo(chatId, localFilePath, {
          caption: `הנה קובץ הווידאו שלך: ${result.title}`,
          filename: `${sanitizedTitle}${fileExtension}`,
          contentType: 'video/mp4'
        });
      } else {
        await bot.sendAudio(chatId, s3Url, {
          caption: `הנה קובץ האודיו שלך: ${result.title}`,
          filename: `${sanitizedTitle}${fileExtension}`,
          contentType: 'audio/mpeg'
        });
      }
      
      await redisClient.setEx(`${parsed.i}-${format}-${quality || 'default'}`, 86400, JSON.stringify({ s3Url, title: result.title }));
      
      fs.unlink(localFilePath, (err) => {
        if (err) console.error('Error deleting temporary file:', err);
      });
    } catch (error) {
      console.error('Download processing error:', error.message);
      // Only send an error message if it's not a cancellation.
      if (error.message !== 'הורדה בוטלה על ידי המשתמש') {
        try {
          await bot.sendMessage(chatId, `שגיאה: ${error.message}`);
        } catch (e) {
          console.error('Error sending error message:', e.message);
        }
      }
    }
    activeDownloads[chatId] = false;
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
