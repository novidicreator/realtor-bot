// index.js
// Единый файл: Telegram + Express + OpenAI Vision
// Требуемые ENV (Render → Environment):
// - BOT_TOKEN
// - OPENAI_API_KEY
// - OPENAI_VISION_MODEL (опц., по умолчанию gpt-4o-mini)
// - WEBHOOK_HOST  (например: https://realtor-bot-xxxx.onrender.com)
// - WEBHOOK_PATH_SECRET  (например: mysecretpath)
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import OpenAI from 'openai';

// ─────────── Настройки из окружения ───────────
const {
  BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_VISION_MODEL = 'gpt-4o-mini',
  WEBHOOK_HOST,              // например: https://realtor-bot-xxxx.onrender.com
  WEBHOOK_PATH_SECRET = 'secret-path'
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
if (!WEBHOOK_HOST) console.warn('⚠️ WEBHOOK_HOST не задан: вебхук через API не установим');

// Render выдаёт свой порт
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_PATH_SECRET}`;
const WEBHOOK_URL = `${WEBHOOK_HOST}${WEBHOOK_PATH}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 15_000 });

// ─────────── Память сессий по чатам ───────────
const sessions = new Map();
/** получить/создать сессию для чата */
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      target: null,      // "Продажа" | "Аренда" | "Презентация"
      lang: 'ru',        // 'ru' | 'en' | 'sr' ...
      meta: '',          // текст метаданных
      photos: []         // [{fileId, fileUrl}]
    });
  }
  return sessions.get(chatId);
}

// ─────────── Утилиты ───────────
const normalizeTarget = (t) => {
  if (!t) return null;
  const s = String(t).toLowerCase();
  if (/(продажа|sell|sale)/i.test(s)) return 'Продажа';
  if (/(аренда|rent|сдача)/i.test(s)) return 'Аренда';
  if (/(презентац|presentation)/i.test(s)) return 'Презентация';
  return null;
};

const LANG_HINT = `Язык: ru/en/sr (пример: "Язык: ru")`;

const META_TEMPLATE = `Пришли данные как есть, своим текстом.
Подсказка - адрес, тип (квартира/дом), площадь, комнаты, этаж/этажность, год постройки.
Документы: право собственности, выписка ЕГРН, количество собственников, отсутствие долгов.
Дом и район: материал, лифт, двор, рядом школы/магазины/транспорт.
Квартира: ремонт, планировка, окна, что остаётся из мебели/техники.
Финансы: цена, торг, ипотека/маткапитал.
Маркетинг: фото, планировка, описание...`;

// ─────────── Команды ───────────
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  sessions.delete(chatId); // сбрасываем
  const kb = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔁 Новый объект', callback_data: 'NEW_FLOW' }]
      ]
    }
  };
  await ctx.reply(
    `Привет! Я бот-риелтор. Сгенерирую объявление с фото.\n\n` +
    `Нажми «Новый объект» или отправь /new.\n` +
    `После — ${LANG_HINT}`,
    kb
  );
});

bot.command('new', async (ctx) => {
  const chatId = ctx.chat.id;
  sessions.delete(chatId);
  const s = getSession(chatId);

  // Попробуем считать цель из аргументов команды: "/new Продажа"
  const arg = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  const tgt = normalizeTarget(arg);
  if (tgt) s.target = tgt;

  await ctx.reply(`Цель: ${s.target ? s.target : 'не задана'}\n${LANG_HINT}`);
  await ctx.reply(META_TEMPLATE);
  await ctx.reply('После метаданных — пришли 3–12 фото (можно альбомом). Когда закончишь — нажми кнопку ниже.', {
    reply_markup: { inline_keyboard: [[{ text: 'Готово, фото загружены ✅', callback_data: 'PHOTOS_DONE' }]] }
  });
});

// Выбор языка: "Язык: ru"
bot.hears(/^\s*язык\s*:\s*([a-z]{2})\s*$/i, async (ctx) => {
  const lang = ctx.match[1].toLowerCase();
  const chatId = ctx.chat.id;
  const s = getSession(chatId);
  s.lang = lang;
  await ctx.reply(`Ок, язык: ${lang.toUpperCase()}`);
});

// Установка цели: пользователь может просто написать "Продажа" после /new
bot.hears(/^(продажа|аренда|презентация)$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);
  s.target = normalizeTarget(ctx.message.text) || s.target;
  await ctx.reply(`Цель: ${s.target || 'не распознана'}`);
});

// Принимаем метаданные — первое «произвольное» текстовое сообщение после /new
bot.on('text', async (ctx, next) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);

  const txt = (ctx.message?.text || '').trim();

  // служебные фразы пропустим дальше
  if (
    /^\/(start|new|help)/i.test(txt) ||
    /^язык\s*:/i.test(txt) ||
    /^(продажа|аренда|презентация)$/i.test(txt) ||
    /создай\s+описание/i.test(txt)
  ) return next();

  // если ещё нет метаданных — примем это сообщение как метаданные
  if (!s.meta) {
    s.meta = txt;
    await ctx.reply('Принял метаданные. Пришли 3–12 фото. Когда закончишь — нажми кнопку ниже.', {
      reply_markup: { inline_keyboard: [[{ text: 'Готово, фото загружены ✅', callback_data: 'PHOTOS_DONE' }]] }
    });
    return;
  }

  return next();
});

// Фото (одиночные и в альбомах)
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);

  try {
    const photos = ctx.message.photo;
    if (!photos?.length) return;
    // Берём самое большое превью
    const fileId = photos[photos.length - 1].file_id;
    const link = await ctx.telegram.getFileLink(fileId);

    if (!s.photos.find(p => p.fileId === fileId)) {
      s.photos.push({ fileId, fileUrl: link.href });
    }

    await ctx.reply(`Фото добавлено ✅ (всего: ${s.photos.length})`, {
      reply_to_message_id: ctx.message.message_id
    });
  } catch (err) {
    console.error('PHOTO_HANDLER_ERROR:', err);
    await ctx.reply('Не удалось принять фото 😔. Пришли ещё раз.');
  }
});

// Кнопка «Готово, фото загружены ✅»
bot.action('PHOTOS_DONE', async (ctx) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);
  await ctx.answerCbQuery();

  if (!s.photos.length) {
    return ctx.reply('Пока нет ни одного фото. Пришли 3–12 фото и снова нажми кнопку.');
  }

  await ctx.reply('Готово, фото загружены ✅');
  await ctx.reply('Теперь напиши: «Создай описание».');
});

// Генерация — по фразе «Создай описание»
bot.hears(/создай\s+описание/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);

  if (!s.photos.length) {
    return ctx.reply('Нужно сначала прислать 3–12 фото и нажать «Готово, фото загружены ✅».');
  }

  const MAX_IMAGES = 8;                    // ограничим для Vision
  const imgs = s.photos.slice(0, MAX_IMAGES);

  const system = `Ты эксперт-риелтор по недвижимости в Сербии г Novi Sad и опытный редактор объявлений, маркетолог.
-  Распознаешь что на фото (мебель, техника и т.д).
- Если есть название улицы ты анализируешь что из инфраструктуры находится рядом и добавляешь в описание.
- Пишешь продающие объявления которые цепляют с первых двух строчек.
- Пиши кратко и убедительно.
- Не придумывай факты, которых нет в метаданных или на фото.
- Не добавляй в описание лишние символы типа #*
- Если видно несоответствия на фото, аккуратно игнорируй спорные детали, не делай выводов без подтверждения.
- Распазнаешь если написано "36м","36 кв м", "36 квм" то это 36 квадратных метров площадь и т.д, цифра 36 указанна для примера, могут быть любые.
Структура:
1) Заголовок (тип сделки, метраж, район/улица)
2) Описание: планировка, состояние, мебель/техника, коммуникации, этаж/этажность
3) Особенности и локация
4) Условия сделки (цена, доступно с, контакты)
5) Блок «Для площадок»: 3–5 ключевых преимуществ в виде списка

Без воды, цифры и факты. Язык: ${s.lang || 'ru'}. Цель: ${s.target || 'Продажа'}.`;

  const userText = `Сгенерируй объявление по метаданным и фото.

Метаданные:
${s.meta || '(метаданных нет)'}.

Используй вид из фото: ремонт, техника, мебель, санузел, кухня, покрытие пола, окна/вид, состояние подъезда/дома, и т.д.`;

  try {
    await ctx.reply('Генерирую описание… 10–20 секунд ⏳');

    const userContent = [
      { type: 'text', text: userText },
      ...imgs.map(p => ({ type: 'image_url', image_url: { url: p.fileUrl } }))
    ];

    // OpenAI Vision
    const completion = await openai.chat.completions.create({
      model: OPENAI_VISION_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    });

    const draft = completion.choices?.[0]?.message?.content?.trim();
    if (!draft) throw new Error('Empty completion');

    await ctx.reply(draft, { disable_web_page_preview: true });

    // Сброс под новый объект (язык/цель оставим)
    sessions.set(chatId, {
      target: s.target,
      lang: s.lang,
      meta: '',
      photos: []
    });

  } catch (err) {
    console.error('DESCRIBE_ERROR:', err);
    const msg =
      err?.status === 401 ? 'Ошибка 401 у OpenAI (ключ?). Проверь OPENAI_API_KEY в Render → Environment.'
    : err?.status === 429 ? 'Перегрузка/лимит OpenAI (429). Подожди минуту или проверь биллинг.'
    : 'Не вышло создать описание 😔. Я записал ошибку в логи Render.';
    await ctx.reply(msg);
  }
});

// Кнопка «Новый объект» из /start
bot.action('NEW_FLOW', async (ctx) => {
  await ctx.answerCbQuery();
  sessions.delete(ctx.chat.id);
  await ctx.reply('Ок! Новый объект. Сначала выбери цель (просто напиши: Продажа/Аренда/Презентация), затем задай язык — ' + LANG_HINT);
  await ctx.reply(META_TEMPLATE);
  await ctx.reply('После метаданных пришли 3–12 фото и нажми кнопку ниже.', {
    reply_markup: { inline_keyboard: [[{ text: 'Готово, фото загружены ✅', callback_data: 'PHOTOS_DONE' }]] }
  });
});

// ─────────── Express + Webhook ───────────
const app = express();

// Чтобы Telegram видел «живой» корень
app.get('/', (req, res) => res.type('text/plain').send('OK'));

// Подключаем webhook callback Telegraf
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`✅ Webhook server on ${PORT}, path=${WEBHOOK_PATH}`);

  // Пытаемся поставить вебхук автоматически (если есть WEBHOOK_HOST)
  try {
    if (WEBHOOK_HOST) {
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log('WEBHOOK_READY:', WEBHOOK_URL);
    } else {
      console.log('WEBHOOK_NOT_SET: задайте WEBHOOK_HOST в ENV и поставьте вебхук руками через Telegram API.');
    }
  } catch (err) {
    console.error('SET_WEBHOOK_ERROR:', err);
  }
});


