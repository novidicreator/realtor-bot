// index.js
import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch';
import { OpenAI } from 'openai';

/* ========= ENV ========= */
const {
  BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_VISION_MODEL = 'gpt-4o-mini',
  WEBHOOK_HOST,                 // пример: https://realtor-bot-t70.onrender.com  (без слэша в конце)
  WEBHOOK_PATH_SECRET = 'hook', // пример: mysecretpath
} = process.env;

if (!BOT_TOKEN || !OPENAI_API_KEY) {
  console.error('❌ BOT_TOKEN или OPENAI_API_KEY не заданы');
  process.exit(1);
}

/* ========= CORE ========= */
const app = express();
const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ========= PRIMITIVE SESSION ========= */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: 'idle', payload: {}, photos: [] });
  }
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { step: 'idle', payload: {}, photos: [] });
}

/* ========= HELPERS ========= */
function chunkText(str, size = 3500) {
  const parts = [];
  let s = str || '';
  while (s.length > size) {
    let i = s.lastIndexOf('\n', size);
    if (i < 0) i = size;
    parts.push(s.slice(0, i));
    s = s.slice(i);
  }
  if (s) parts.push(s);
  return parts;
}

function parseMeta(text = '') {
  const pick = (label) => (text.match(new RegExp(`\\*?${label}\\*?\\s*:\\s*([^\\n]+)`, 'i')) || [, ''])[1].trim();
  const num = (s) => (s || '').replace(',', '.').match(/[0-9.]+/)?.[0] || '';
  return {
    address: pick('Адрес'),
    district: pick('Район'),
    totalArea: num(pick('Площадь')),
    layout: pick('Планировка'),
    floor: pick('Этаж'),
    floorsTotal: pick('Этажность дома'),
    ceilingHeight: pick('Потолки'),
    communications: pick('Коммуникации'),
    extras: pick('Особенности локации'),
    petsPolicy: pick('Животные'),
    availableFrom: pick('Доступно с'),
    price: pick('Цена'),
    contact: pick('Контакт'),
  };
}

async function tgFileToDataUrl(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (file.file_path || '').toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* ========= OPENAI: VISION EXTRACT ========= */
const FEATURE_SCHEMA = {
  type: "object",
  properties: {
    condition: { type: "string" },
    furniture: { type: "array", items: { type: "string" } },
    appliances: { type: "array", items: { type: "string" } },
    standout_features: { type: "array", items: { type: "string" } },
    possible_drawbacks: { type: "array", items: { type: "string" } },
    confidence: { type: "string" }
  },
  required: ["condition","furniture","appliances","standout_features","possible_drawbacks","confidence"],
  additionalProperties: true
};

async function openaiExtractFeatures(imageDataUrls) {
  const messages = [
    { role: "system", content: [{ type: "text", text: "Ты помощник по недвижимости. Верни ТОЛЬКО валидный JSON по схеме без пояснений." }] },
    {
      role: "user",
      content: [
        { type: "text", text: `Схема:\n${JSON.stringify(FEATURE_SCHEMA, null, 2)}\nВерни чистый JSON.` },
        ...imageDataUrls.map(u => ({ type: "image_url", image_url: { url: u, detail: "high" } }))
      ]
    }
  ];
  const r = await openai.chat.completions.create({ model: OPENAI_VISION_MODEL, messages, temperature: 0.2 });
  const raw = r.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(raw); } catch {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e >= 0) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
    return {};
  }
}

/* ========= OPENAI: COPY ========= */
function buildListingPrompt(meta, feats) {
  return `
Составь объявление. Цель: ${meta.dealType}. Язык: ${meta.language}.
Данные (мета): ${JSON.stringify(meta)}
Признаки по фото: ${JSON.stringify(feats)}
Структура:
1) 3 коротких заголовка;
2) Плюсы (5–8 буллетов);
3) Минусы (2–5);
4) Основной текст 6–10 предложений с учетом цели (продажа/аренда/презентация);
5) Хэштеги (10–15, одной строкой);
6) Призыв к действию с контактом: ${meta.contact || 'пишите в чат'}.
`.trim();
}

async function openaiBuildListing(meta, feats) {
  const r = await openai.chat.completions.create({
    model: OPENAI_VISION_MODEL,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Ты проф. копирайтер по недвижимости. Пиши ёмко и честно, без воды.' }] },
      { role: 'user', content: [{ type: 'text', text: buildListingPrompt(meta, feats) }] }
    ],
    temperature: 0.4
  });
  return r.choices?.[0]?.message?.content || '';
}

/* ========= UI ========= */
const dealKb = Markup.inlineKeyboard([
  [Markup.button.callback('Продажа', 'deal_sale'), Markup.button.callback('Аренда', 'deal_rent')],
  [Markup.button.callback('Презентация', 'deal_promo')]
]);
const langKb = Markup.inlineKeyboard([
  [Markup.button.callback('Русский (ru)', 'lang_ru'), Markup.button.callback('Srpski (sr)', 'lang_sr')],
  [Markup.button.callback('English (en)', 'lang_en')]
]);
const doneKb = Markup.inlineKeyboard([[Markup.button.callback('Готово, фото загружены ✅', 'photos_done')]]);

/* ========= SCENARIO ========= */
bot.start(async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.replyWithMarkdown('Привет! Я *Бот риелтор*. Набери */new* чтобы начать.');
});

bot.command('new', async (ctx) => {
  resetSession(ctx.chat.id);
  const s = getSession(ctx.chat.id);
  s.step = 'deal';
  await ctx.reply('Выбери цель:', dealKb);
});

bot.action(['deal_sale', 'deal_rent', 'deal_promo'], async (ctx) => {
  const s = getSession(ctx.chat.id);
  if (s.step !== 'deal') return ctx.answerCbQuery();
  s.payload.dealType = { deal_sale: 'Продажа', deal_rent: 'Аренда', deal_promo: 'Презентация' }[ctx.callbackQuery.data];
  s.step = 'lang';
  await ctx.editMessageText(`Цель: ${s.payload.dealType}`);
  await ctx.reply('Выбери язык:', langKb);
});

bot.action(['lang_ru', 'lang_sr', 'lang_en'], async (ctx) => {
  const s = getSession(ctx.chat.id);
  if (s.step !== 'lang') return ctx.answerCbQuery();
  s.payload.language = { lang_ru: 'ru', lang_sr: 'sr', lang_en: 'en' }[ctx.callbackQuery.data];
  s.step = 'meta';
  await ctx.editMessageText(`Язык: ${s.payload.language}`);
  await ctx.replyWithMarkdown(
`Пришли **метаданные** одним сообщением по образцу:

*Адрес:* ...
*Район:* ...
*Площадь:* 45
*Планировка:* 1к
*Этаж:* 3
*Этажность дома:* 9
*Потолки:* 2.7
*Коммуникации:* ...
*Особенности локации:* ...
*Животные:* ...
*Доступно с:* ...
*Цена:* ...
*Контакт:* ...

После этого пришли 3–12 фото (можно альбомом).`
  );
});

bot.on('text', async (ctx, next) => {
  const s = getSession(ctx.chat.id);
  if (s.step === 'meta') {
    s.payload = { ...s.payload, ...parseMeta(ctx.message.text) };
    s.step = 'collect_photos';
    await ctx.reply('Принял метаданные. Пришли 3–12 фото. Когда закончишь — нажми кнопку.', doneKb);
    return;
  }
  return next();
});

bot.on('photo', async (ctx, next) => {
  const s = getSession(ctx.chat.id);
  if (s.step !== 'collect_photos') return next();
  const best = (ctx.message.photo || []).sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
  if (best) {
    s.photos.push({ file_id: best.file_id });
    await ctx.reply(`Фото добавлено ✅ (всего: ${s.photos.length})`, { reply_to_message_id: ctx.message.message_id });
  }
});

bot.action('photos_done', async (ctx) => {
  const s = getSession(ctx.chat.id);
  if (s.step !== 'collect_photos') return ctx.answerCbQuery();
  if (s.photos.length < 1) return ctx.answerCbQuery('Сначала пришли фото', { show_alert: true });

  await ctx.editMessageText(`Фото получены: ${s.photos.length}. Анализирую…`);
  try {
    const imgs = [];
    for (const p of s.photos.slice(0, 12)) imgs.push(await tgFileToDataUrl(ctx, p.file_id));

    await ctx.reply('🔎 Извлекаю признаки…');
    const feats = await openaiExtractFeatures(imgs);

    await ctx.reply('📝 Собираю текст…');
    const text = await openaiBuildListing(s.payload, feats);

    await ctx.replyWithMarkdown('*Извлечённые признаки (JSON):*');
    await ctx.reply('```\n' + JSON.stringify(feats, null, 2) + '\n```', { parse_mode: 'Markdown' });

    await ctx.replyWithMarkdown('*Готовый текст объявления:*');
    for (const part of chunkText(text, 3500)) await ctx.reply(part);

    await ctx.reply('Готово ✅ /new чтобы начать заново');
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ Ошибка. Проверь ключи/переменные и попробуй /new');
  } finally {
    resetSession(ctx.chat.id);
  }
});

/* ========= START: WEBHOOK or POLLING ========= */
const PORT = process.env.PORT || 3000;            // <-- не задаём в env вручную

if (WEBHOOK_HOST) {
  const path = `/telegraf/${WEBHOOK_PATH_SECRET}`;
  app.use(express.json());

  // health & GET-checks
  app.get('/', (_, res) => res.status(200).send('OK'));
  app.get(path, (_, res) => res.status(200).send('OK'));

  // основной обработчик вебхука (POST)
  app.post(path, bot.webhookCallback(path));

  // регистрируем webhook (без лишних перезапросов порта)
  bot.telegram.setWebhook(`${WEBHOOK_HOST}${path}`, { drop_pending_updates: true });

  // запускаем HTTP-сервер на выданном Render порту
  const server = app.listen(PORT, () => {
    console.log(`✅ Webhook server on ${PORT}, path=${path}`);
  });
  server.on('error', (err) => {
    console.error('HTTP server error:', err);
    process.exit(1);
  });
} else {
  // fallback: polling
  bot.launch().then(() => console.log('✅ Bot started in polling mode'));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}


