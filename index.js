import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch';
import { OpenAI } from 'openai';

// ---------- ENV ----------
const {
  BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_VISION_MODEL = 'gpt-4o-mini',
  PORT = 10000,
  WEBHOOK_HOST,
  WEBHOOK_PATH_SECRET = 'hook'
} = process.env;

if (!BOT_TOKEN || !OPENAI_API_KEY) {
  console.error('❌ BOT_TOKEN или OPENAI_API_KEY не заданы');
  process.exit(1);
}

// ---------- INIT ----------
const app = express();
const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- простая сессия ----------
const sessions = new Map();
const getSession = (id) =>
  sessions.get(id) ||
  (sessions.set(id, { step: 'idle', payload: {}, photos: [] }), sessions.get(id));
const resetSession = (id) => sessions.set(id, { step: 'idle', payload: {}, photos: [] });

// ---------- утилиты ----------
async function tgFileToDataUrl(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (file.file_path || '').toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

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
    { role: "system", content: [{ type: "text", text: "Ты помощник по недвижимости. Верни ТОЛЬКО валидный JSON по схеме." }] },
    {
      role: "user",
      content: [
        { type: "text", text: `Схема:\n${JSON.stringify(FEATURE_SCHEMA, null, 2)}\nВерни чистый JSON без пояснений.` },
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

function chunk(txt, n = 3500) {
  const out = []; let s = txt || '';
  while (s.length > n) { let i = s.lastIndexOf('\n', n); if (i < 0) i = n; out.push(s.slice(0, i)); s = s.slice(i); }
  if (s) out.push(s);
  return out;
}

function parseMeta(text = '') {
  const g = (l) => (text.match(new RegExp(`\\*?${l}\\*?\\s*:\\s*([^\\n]+)`, 'i')) || [, ''])[1].trim();
  const num = (s) => (s || '').replace(',', '.').match(/[0-9.]+/)?.[0] || '';
  return {
    address: g('Адрес'),
    district: g('Район'),
    totalArea: num(g('Площадь')),
    layout: g('Планировка'),
    floor: g('Этаж'),
    floorsTotal: g('Этажность дома'),
    ceilingHeight: g('Потолки'),
    communications: g('Коммуникации'),
    extras: g('Особенности локации'),
    petsPolicy: g('Животные'),
    availableFrom: g('Доступно с'),
    price: g('Цена'),
    contact: g('Контакт')
  };
}

function buildListingPrompt(meta, feats) {
  return `
Составь объявление. Цель: ${meta.dealType}. Язык: ${meta.language}.
Данные: ${JSON.stringify(meta)}
Признаки по фото: ${JSON.stringify(feats)}
Структура:
1) 3 коротких заголовка;
2) Плюсы (5–8);
3) Минусы (2–5);
4) Основной текст (6–10 предложений, под цель);
5) Хэштеги (10–15, одной строкой);
6) Призыв к действию + контакт: ${meta.contact || 'пишите в чат'}.
`.trim();
}

async function openaiBuildListing(meta, feats) {
  const r = await openai.chat.completions.create({
    model: OPENAI_VISION_MODEL,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Ты проф. копирайтер по недвижимости. Пиши ёмко и честно.' }] },
      { role: 'user', content: [{ type: 'text', text: buildListingPrompt(meta, feats) }] }
    ],
    temperature: 0.4
  });
  return r.choices?.[0]?.message?.content || '';
}

// ---------- UI ----------
const dealKb = Markup.inlineKeyboard([
  [Markup.button.callback('Продажа', 'deal_sale'), Markup.button.callback('Аренда', 'deal_rent')],
  [Markup.button.callback('Презентация', 'deal_promo')]
]);
const langKb = Markup.inlineKeyboard([
  [Markup.button.callback('Русский (ru)', 'lang_ru'), Markup.button.callback('Srpski (sr)', 'lang_sr')],
  [Markup.button.callback('English (en)', 'lang_en')]
]);
const doneKb = Markup.inlineKeyboard([[Markup.button.callback('Готово, фото загружены ✅', 'photos_done')]]);

// ---------- сценарий ----------
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
  s.step =
