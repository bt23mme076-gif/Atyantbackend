import { launchPage, splitName, detectCaptcha, findUnfilledRequired, waitForForm, fillCombobox, dedupeByLabel } from './PlaywrightRunner.js';
import { normalizeQuestionKey } from '../../models/ApplicationAnswer.js';

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
    if (await page.locator('#email').count()) await page.fill('#email', user.email || '');
    if (user.autoApply?.phone && (await page.locator('#phone').count())) {
      await page.fill('#phone', user.autoApply.phone);
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
      if (!field.id || !field.label) continue;
      const answer = savedAnswers[normalizeQuestionKey(field.label)];
      if (!answer) continue;

      if (field.isCombobox) {
        await fillCombobox(page, field.id, answer);
      } else {
        await page.fill(`#${field.id}`, answer).catch(() => {});
      }
    }

    unfilled = await findUnfilledRequired(page);
    if (unfilled.length > 0) {
      const unansweredQuestions = dedupeByLabel(unfilled, normalizeQuestionKey);
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
    await submitBtn.click();
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const confirmed = /thank you|application (received|submitted)|we.?ve received your application/i.test(bodyText);

    if (!confirmed) {
      return { status: 'needs_manual_action', reason: 'No confirmation text detected after submit — verify manually' };
    }

    return { status: 'submitted', confirmationText: bodyText.slice(0, 500) };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  } finally {
    await browser.close();
  }
}
