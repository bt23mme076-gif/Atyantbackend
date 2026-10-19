import { launchPage, splitName, detectCaptcha, findUnfilledRequired, waitForForm, fillCombobox, dedupeByLabel, fillField, describeUnanswered } from './PlaywrightRunner.js';
import { normalizeQuestionKey } from '../../models/ApplicationAnswer.js';
import { applyEmailFor, inboxEnabled, waitForSecurityCode } from './inbox.js';

const DIAL_COUNTRY = [['+971', 'United Arab Emirates'], ['+44', 'United Kingdom'], ['+65', 'Singapore'], ['+61', 'Australia'], ['+49', 'Germany'], ['+91', 'India'], ['+1', 'United States']];

// Atyant students are India-first, so a number with no country code is Indian.
function countryForPhone(phone) {
  const p = String(phone).replace(/[^\d+]/g, '');
  return DIAL_COUNTRY.find(([code]) => p.startsWith(code))?.[1] || 'India';
}

// Saved answers are keyed by exact question wording, so the same demographic
// question phrased differently by each company would be re-asked every time.
// Gender is matched across wordings; anything ambiguous (transgender, pronouns,
// orientation) still needs its own answer.
const GENDER_Q = /gender/;
const NOT_GENDER_Q = /transgender|pronoun|expression|orientation/;
function savedAnswerFor(savedAnswers, label) {
  const key = normalizeQuestionKey(label);
  if (savedAnswers[key]) return savedAnswers[key];
  if (GENDER_Q.test(key) && !NOT_GENDER_Q.test(key)) {
    const match = Object.keys(savedAnswers).find((k) => GENDER_Q.test(k) && !NOT_GENDER_Q.test(k));
    if (match) return savedAnswers[match];
  }
  return undefined;
}

// Greenhouse shows the emailed code either as one input or as a row of
// single-character boxes that auto-advance as you type.
async function enterSecurityCode(page, code) {
  const boxes = page.locator('input[maxlength="1"]:visible');
  const nBoxes = await boxes.count();
  if (nBoxes >= code.length) {
    await boxes.first().click();
    await page.keyboard.type(code, { delay: 80 });
    return { ok: true };
  }
  const single = page.locator('input[id*="security" i], input[name*="security" i], input[aria-label*="security" i], input[autocomplete="one-time-code"]').first();
  if (await single.count()) {
    await single.fill(code);
    return { ok: true };
  }
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).filter((el) => el.offsetParent)
    .map((el) => `${el.type}#${el.id || el.name || '?'}/${el.maxLength}`).slice(-8).join(', '));
  return { ok: false, detail: `no code input found; inputs: ${inputs}` };
}

/**
 * Fills and submits a Greenhouse-hosted application form using only the
 * identity fields we can answer with certainty (name, email, phone, resume),
 * plus any question the student has already answered once before (savedAnswers,
 * keyed by normalized question text). Anything still required and empty after
 * that — a genuinely new screening question — aborts to needs_manual_action
 * with the question text attached, so the student can answer it once and it's
 * saved for every future application.
 */
export async function applyGreenhouse({ job, user, resumeBuffer, resumeFilename, coverLetterText, savedAnswers = {}, dryRun = false }) {
  const { browser, page } = await launchPage();
  try {
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (!(await waitForForm(page, '#first_name, #email, input[type="file"]'))) {
      return { status: 'needs_manual_action', reason: 'Application form did not load — apply manually' };
    }

    if (await detectCaptcha(page)) {
      return { status: 'needs_manual_action', reason: 'CAPTCHA present on application form' };
    }

    const { firstName, lastName } = splitName(user.name);

    if (await page.locator('#first_name').count()) await page.fill('#first_name', firstName);
    if (await page.locator('#last_name').count()) await page.fill('#last_name', lastName);
    const applyEmail = await applyEmailFor(user);
    if (await page.locator('#email').count()) await page.fill('#email', applyEmail);
    if (user.autoApply?.phone && (await page.locator('#phone').count())) {
      await page.fill('#phone', user.autoApply.phone);
      // The phone's country picker is marked optional but the form rejects the
      // submit ("Country: Select a country") once a number is entered.
      if (await page.locator('input#country[role="combobox"]').count()) {
        await fillCombobox(page, 'country', countryForPhone(user.autoApply.phone));
      }
    }
    if (resumeBuffer && (await page.locator('#resume').count())) {
      await page.setInputFiles('#resume', {
        name: resumeFilename || 'resume.pdf',
        mimeType: 'application/pdf',
        buffer: resumeBuffer,
      });
    }
    if (coverLetterText && (await page.locator('#cover_letter').count())) {
      await page.setInputFiles('#cover_letter', {
        name: 'cover_letter.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(coverLetterText, 'utf-8'),
      });
    }

    // Apply any question the student has already answered before, then
    // re-check — only genuinely new questions should reach the student.
    let unfilled = await findUnfilledRequired(page);
    for (const field of unfilled) {
      if (!field.label) continue;
      const answer = savedAnswerFor(savedAnswers, field.label);
      if (!answer) continue;
      await fillField(page, field, answer);
    }

    unfilled = await findUnfilledRequired(page);
    if (unfilled.length > 0) {
      const unansweredQuestions = await describeUnanswered(page, dedupeByLabel(unfilled, normalizeQuestionKey));
      return {
        status: 'needs_manual_action',
        reason: `Unanswered required field(s): ${unansweredQuestions.map((q) => q.label || q.name).join(', ')}`,
        unansweredQuestions,
      };
    }

    if (dryRun) {
      return { status: 'dry_run', reason: 'All known-safe fields filled; would submit.' };
    }

    const submitBtn = page.locator('button[type="submit"], #submit_app').first();
    const submittedAt = new Date();
    await submitBtn.click();

    // The confirmation renders asynchronously (often a client-side route change
    // after the submit XHR), so poll instead of reading the page once.
    const CONFIRMED = /thank you|application (received|submitted)|we.?ve received your application|successfully submitted/i;
    const VERIFY_CODE = /security code|verification code|verify your email/i;
    let bodyText = '';
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      bodyText = await page.locator('body').innerText().catch(() => '');
      if (CONFIRMED.test(bodyText) || /confirmation/i.test(page.url()) || VERIFY_CODE.test(bodyText)) break;
    }

    if (CONFIRMED.test(bodyText) || /confirmation/i.test(page.url())) {
      return { status: 'submitted', confirmationText: bodyText.slice(0, 500) };
    }
    if (VERIFY_CODE.test(bodyText)) {
      if (!inboxEnabled()) {
        return { status: 'needs_manual_action', reason: 'Greenhouse sent a verification code to your email — enter it on the company site to finish' };
      }
      const code = await waitForSecurityCode(applyEmail, submittedAt);
      if (!code) return { status: 'failed', reason: 'Greenhouse security code email did not arrive in 2 minutes — try again' };

      const entered = await enterSecurityCode(page, code);
      if (!entered.ok) return { status: 'needs_manual_action', reason: `Could not enter the security code (${entered.detail})` };

      await page.locator('button[type="submit"], #submit_app').first().click();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1000);
        bodyText = await page.locator('body').innerText().catch(() => '');
        if (CONFIRMED.test(bodyText) || /confirmation/i.test(page.url())) {
          return { status: 'submitted', confirmationText: bodyText.slice(0, 500) };
        }
      }
    }

    const errors = await page.evaluate(() => Array.from(document.querySelectorAll(
      '[role="alert"], .error, .field-error, [class*="error" i], [aria-invalid="true"]',
    )).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 3).join(' | ')).catch(() => '');
    const detail = errors || bodyText.replace(/\s+/g, ' ').slice(0, 160);
    return { status: 'needs_manual_action', reason: `Submit not confirmed — ${detail || 'page showed nothing'} (${page.url().slice(0, 80)})` };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  } finally {
    await browser.close();
  }
}
