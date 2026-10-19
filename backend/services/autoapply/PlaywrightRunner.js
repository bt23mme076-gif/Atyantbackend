import { chromium } from 'playwright';
import axios from 'axios';

// In production the browser runs in its own browserless container so a
// stuck/crashed Chromium can't take the API process down with it — the auto
// apply engine is exactly the kind of long-running, form-heavy automation
// that occasionally hangs a tab. Falls back to a locally launched Chromium
// when BROWSERLESS_WS_URL isn't set (local dev has no browserless running).
export async function launchPage() {
  const browser = process.env.BROWSERLESS_WS_URL
    ? await chromium.connectOverCDP(process.env.BROWSERLESS_WS_URL)
    : await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, page };
}

export async function downloadFileBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20_000 });
  return Buffer.from(res.data);
}

export function splitName(fullName = '') {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Greenhouse/Lever boards are React-rendered — the form often mounts after
// domcontentloaded. Without this wait, field locators resolve to 0 matches,
// the fills silently no-op, and the form then reports those same fields as
// unanswered. Returns false if no form appeared at all.
export async function waitForForm(page, selector, timeout = 15_000) {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout });
  } catch {
    return false;
  }

  // The form element existing isn't enough — Greenhouse/Lever's React app
  // keeps re-rendering (and silently wiping anything already typed) until its
  // background requests settle. Filling before that finishes is why earlier
  // runs "succeeded" on forms that were actually still empty. Best-effort:
  // if the page never goes idle (some boards ping analytics continuously),
  // proceed anyway rather than failing the whole application on that alone.
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch { /* proceed with whatever state the form is in */ }

  return true;
}

// Google's "invisible" reCAPTCHA runs a passive risk check on nearly every
// Greenhouse form via a 0-size anchor iframe (size=invisible) — it resolves
// itself silently when the page's own JS calls grecaptcha.execute() on submit,
// no interaction needed, same as it would for a real human clicking Submit.
// That is not a challenge. Only a rendered, visible widget or challenge frame
// (the actual checkbox, an hCaptcha/Turnstile frame, or reCAPTCHA's "bframe"
// that pops up when verification is actually required) counts as one — and
// if that's what's on screen, we stop. Solving/bypassing it is off the table
// regardless of context.
export async function detectCaptcha(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const challengeFrame = Array.from(document.querySelectorAll('iframe')).some((el) => {
      const src = el.src || '';
      const isInvisibleAnchor = /recaptcha.*\/(anchor|api2\/anchor)/.test(src) && /size=invisible/.test(src);
      if (isInvisibleAnchor) return false;
      const looksLikeCaptcha = /captcha|hcaptcha|turnstile/i.test(src) || /challenge/i.test(el.title || '');
      return looksLikeCaptcha && isVisible(el);
    });

    const visibleWidget = Array.from(document.querySelectorAll('.g-recaptcha, [data-sitekey]')).some(isVisible);

    return challengeFrame || visibleWidget;
  });
}

// After the safe fields have been filled, anything still required-and-empty
// is a question we don't know how to answer safely (custom screening
// questions, work-authorization, location pickers we couldn't confirm, etc).
// Never guess these — surface them for the student to answer once, then save.
//
// react-select comboboxes (Greenhouse's country/location/custom-question
// pickers) never populate the visible <input>'s .value, even once answered —
// the selection renders as text in a sibling ".select__single-value" node
// instead. Checking .value alone would report these as unfilled forever.
export async function findUnfilledRequired(page) {
  return page.evaluate(() => {
    function getLabel(el) {
      if (el.type === 'radio' || el.type === 'checkbox') {
        const legend = el.closest('fieldset')?.querySelector('legend');
        if (legend && legend.textContent.trim()) return legend.textContent.replace(/\*$/, '').trim();
      }
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent.replace(/\*$/, '').trim();
      }
      const closest = el.closest('label');
      if (closest) return closest.textContent.replace(/\*$/, '').trim();
      let node = el.parentElement;
      for (let i = 0; i < 5 && node; i++) {
        const lbl = node.querySelector('label, legend');
        if (lbl && lbl.textContent.trim()) return lbl.textContent.replace(/\*$/, '').trim();
        node = node.parentElement;
      }
      return '';
    }

    function comboboxHasValue(el) {
      let container = el;
      for (let i = 0; i < 6 && container; i++) {
        const val = container.querySelector('[class*="-singleValue"], [class*="select__single-value"]');
        if (val && val.textContent.trim()) return true;
        container = container.parentElement;
      }
      return false;
    }

    const fields = Array.from(document.querySelectorAll('input, select, textarea'));
    return fields
      .filter((el) => el.type !== 'hidden' && (el.required || el.getAttribute('aria-required') === 'true'))
      .filter((el) => {
        if (el.type === 'radio') {
          const group = el.name ? document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`) : [el];
          return !Array.from(group).some((r) => r.checked);
        }
        if (el.type === 'checkbox') return !el.checked;
        if (el.getAttribute('role') === 'combobox') return !comboboxHasValue(el);
        return !el.value || !String(el.value).trim();
      })
      .map((el) => ({
        id: el.id || '',
        name: el.name || el.id || `${el.tagName.toLowerCase()}[${el.type || ''}]`,
        label: getLabel(el),
        isCombobox: el.getAttribute('role') === 'combobox',
        type: el.getAttribute('role') === 'combobox' ? 'combobox'
          : el.tagName === 'SELECT' ? 'select'
          : el.type === 'radio' || el.type === 'checkbox' ? el.type
          : el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).map((o) => o.textContent.trim()).filter((t) => t && !/^(select|choose|please)/i.test(t))
          : el.type === 'radio' && el.name
            ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
                .map((r) => (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent.trim()) || r.closest('label')?.textContent.trim() || r.value)
                .filter(Boolean)
            : el.type === 'checkbox' ? ['Yes'] : [],
      }));
  });
}

// Selects an option in a react-select combobox by typing the saved answer and
// clicking the matching option (exact match preferred, then substring). Never
// blindly presses Enter on an unconfirmed match — if nothing matches, closes
// the listbox and leaves the field alone rather than risk a wrong selection.
// Greenhouse renders a hidden mirror element alongside every react-select
// combobox sharing the same label — dedupe on the label (or name/id when a
// field genuinely has no label) so the student is asked each question once.
export function dedupeByLabel(fields, normalizeFn) {
  const seen = new Set();
  const out = [];
  for (const f of fields) {
    const key = (f.label && normalizeFn(f.label)) || f.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const norm = (t) => String(t || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
const SYNONYMS = { male: ['man'], female: ['woman'], man: ['male'], woman: ['female'], yes: ['y', 'true', 'i agree', 'i consent'], no: ['n', 'false'] };

export function matchOption(options, answer) {
  const a = norm(answer);
  if (!a) return null;
  const opts = options.map((o) => ({ o, n: norm(o) }));
  const alts = [a, ...(SYNONYMS[a] || [])];
  const hit = opts.find((x) => alts.includes(x.n))
    || opts.find((x) => alts.some((t) => x.n.startsWith(t + ' ')))
    || opts.find((x) => x.n.includes(a) || (x.n.length > 2 && a.includes(x.n)));
  return hit ? hit.o : null;
}

// Fills one field according to its real control type. Plain page.fill only
// works on text inputs, which is why selects/radios/consent boxes kept coming
// back as "unanswered" even after the student answered them.
export async function fillField(page, field, answer) {
  try {
    const key = field.id ? idSelector(field.id) : null;
    if (field.type === 'combobox' || field.isCombobox) return await fillCombobox(page, field.id, answer);
    if (field.type === 'select' && key) {
      const label = matchOption(field.options || [], answer);
      if (!label) return false;
      await page.locator(key).first().selectOption({ label });
      return true;
    }
    if (field.type === 'checkbox' && key) {
      if (!/^(yes|y|true|agree|i agree|consent|accept|ok)\b/i.test(String(answer).trim())) return false;
      await page.locator(key).first().check({ force: true });
      return true;
    }
    if (field.type === 'radio') {
      const label = matchOption(field.options || [], answer);
      if (!label) return false;
      return await page.evaluate(({ name, label }) => {
        const t = (x) => (x || '').trim();
        const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
        const r = radios.find((el) => t((el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.closest('label')?.textContent || el.value) === label);
        if (!r) return false;
        r.click();
        return true;
      }, { name: field.name, label });
    }
    if (!key) return false;
    await page.locator(key).first().fill(String(answer));
    return true;
  } catch {
    return false;
  }
}

// Reads a react-select combobox's choices (so the student can be shown the
// exact options) by opening it, then closing without selecting anything.
export async function readComboboxOptions(page, id) {
  try {
    const sel = idSelector(id);
    await page.click(sel, { timeout: 3000 });
    await page.waitForTimeout(400);
    const options = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const listId = el?.getAttribute('aria-owns') || el?.getAttribute('aria-controls');
      const list = listId ? document.getElementById(listId) : null;
      return list ? Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 15) : [];
    }, sel);
    await page.keyboard.press('Escape').catch(() => {});
    return options;
  } catch {
    return [];
  }
}

export async function describeUnanswered(page, fields) {
  for (const f of fields) {
    if (f.type === 'combobox' && f.id && !(f.options || []).length) f.options = await readComboboxOptions(page, f.id);
    f.hint = f.options && f.options.length
      ? `Type exactly one of: ${f.options.slice(0, 8).join(' / ')}`
      : f.type === 'checkbox' ? 'Type Yes to tick this box' : '';
  }
  return fields;
}

export const idSelector = (id) => `[id=${JSON.stringify(String(id))}]`;

// react-select comboboxes that search as you type (Greenhouse's City/Location
// pickers hit a geocoder) re-render their option list while results stream in,
// so a click on a node found a moment earlier can land on nothing. Wait for the
// list to settle, pick by index, and confirm the chosen value actually rendered
// before reporting success — otherwise retry.
export async function fillCombobox(page, id, value) {
  if (!id) return false;
  const selector = idSelector(id);
  if (!(await page.locator(selector).count())) return false;

  const optionTexts = (s) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const lid = el?.getAttribute('aria-owns') || el?.getAttribute('aria-controls');
    const list = lid && document.getElementById(lid);
    return list ? Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()) : [];
  }, s);

  const isSelected = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const control = el?.closest('.select__control') || el?.parentElement?.parentElement?.parentElement;
    return !!control?.querySelector('.select__single-value, .select__multi-value');
  }, selector);

  const norm = (t) => t.trim().toLowerCase();
  const syn = { male: 'man', female: 'woman', y: 'yes', n: 'no' };
  const v = norm(value);
  const alts = [v, syn[v]].filter(Boolean);
  const pick = (texts) => {
    const i = texts.findIndex((t) => alts.includes(norm(t)));
    if (i >= 0) return i;
    const j = texts.findIndex((t) => alts.some((a) => norm(t).startsWith(a)));
    return j >= 0 ? j : texts.findIndex((t) => norm(t).includes(v));
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click(selector);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.type(selector, value, { delay: 40 });

    // Wait until options appear and stop changing.
    let last = '';
    let texts = [];
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(350);
      texts = await optionTexts(selector);
      const sig = texts.join('|');
      if (texts.length && sig === last) break;
      last = sig;
    }

    const index = pick(texts);
    if (index < 0) {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }

    const lid = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el?.getAttribute('aria-owns') || el?.getAttribute('aria-controls');
    }, selector);
    await page.locator(`[id=${JSON.stringify(lid)}] [role="option"]`).nth(index).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    if (await isSelected()) return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  return false;
}
