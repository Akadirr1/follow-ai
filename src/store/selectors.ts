import {
  ARTICLES,
  FALLBACK_ARTICLE_INDEX,
  type Article,
} from '../data/articles';
import { SOURCES, type Source } from '../data/sources';
import type { State } from './types';

/**
 * Feed = articles whose source is on AND whose category matches the chip.
 * Prototype: `arts.filter(a => s.srcOn[a.id] && (s.filter === 'Tümü' || a.cat === s.filter))`.
 * Article ids and source keys coincide, which is what makes the source toggle
 * filter the feed.
 */
export const selectFeed = (state: State): Article[] =>
  ARTICLES.filter(
    (a) => state.srcOn[a.id] && (state.filter === 'Tümü' || a.cat === state.filter),
  );

export const selectSaved = (state: State): Article[] =>
  ARTICLES.filter((a) => state.saved[a.id]);

export const selectUnreadSavedCount = (state: State): number =>
  selectSaved(state).filter((a) => !state.read[a.id]).length;

/**
 * Live, case-insensitive match over title + source + category.
 *
 * Plain `toLowerCase()` on both sides, as the prototype does
 * (`design/AI Gündem - Prototip.dc.html:362-364`). Turkish-locale folding is wrong
 * here: it maps ASCII `I` to dotless `ı`, so `OpenAI Blog` becomes `openaı blog`
 * and the queries `ai` / `openai` stop matching it (rev-001 B1).
 */
export const selectResults = (state: State): Article[] => {
  const q = state.q.trim().toLowerCase();
  if (!q) return [];
  return ARTICLES.filter((a) =>
    `${a.title} ${a.src} ${a.cat}`.toLowerCase().includes(q),
  );
};

export const selectActiveSourceCount = (state: State): number =>
  SOURCES.filter((s) => state.srcOn[s.k]).length;

export const selectSources = (state: State): (Source & { on: boolean })[] =>
  SOURCES.map((s) => ({ ...s, on: !!state.srcOn[s.k] }));

/**
 * Prototype: `arts.find(a => a.id === s.artId) || arts[2]`. The fallback is kept so
 * a bad route parameter still renders something, but it must not do so silently.
 */
export const selectArticle = (id: string): Article => {
  const found = ARTICLES.find((a) => a.id === id);
  if (!found) {
    console.warn(
      `[store] selectArticle: unknown article "${id}", falling back to "${ARTICLES[FALLBACK_ARTICLE_INDEX].id}"`,
    );
    return ARTICLES[FALLBACK_ARTICLE_INDEX];
  }
  return found;
};

/** Detail body + its label, driven by the Orijinal / Çeviri segment. */
export const selectBody = (
  article: Article,
  seg: State['seg'],
): { text: string; label: string } =>
  seg === 'tr'
    ? { text: article.body, label: 'Çeviri · Türkçe' }
    : { text: article.en, label: 'Orijinal · English' };
