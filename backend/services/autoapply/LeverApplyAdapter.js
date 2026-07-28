import { launchPage, detectCaptcha, findUnfilledRequired, waitForForm, fillCombobox, dedupeByLabel } from './PlaywrightRunner.js';
import { normalizeQuestionKey } from '../../models/ApplicationAnswer.js';

/**
 * Fills and submits a Lever-hosted application form using only the identity
 * fields we can answer with certainty (name, email, phone, resume, links,
 * and location/company only when we actually have that data). Any other
 * required field left empty — Lever's "SUPPLEMENTARY QUESTIONS" section is
 * where these live — aborts to needs_manual_action rather than guessing.
 */
export async function applyLever({ job, user, resumeBuffer, resumeFilename, savedAnswers = {}, dryRun = false }) {
  const { browser, page } = await launchPage();
  try {
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (!(await waitForForm(page, 'input[name="name"], input[name="email"]'))) {
      return { status: 'needs_manual_action', reason: 'Application form did not load — apply manually' };
    }

    if (await detectCaptcha(page)) {
      return { status: 'needs_manual_action', reason: 'CAPTCHA present on application form' };
    }

    if (await page.locator('input[name="name"]').count()) {
      await page.fill('input[name="name"]', user.name || '');
    }
    if (await page.locator('input[name="email"]').count()) {
      await page.fill('input[name="email"]', user.email || '');
    }
    if (user.autoApply?.phone && (await page.locator('input[name="phone"]').count())) {
      await page.fill('input[name="phone"]', user.autoApply.phone);
    }
    if (user.city && (await page.locator('input[name="location"]').count())) {
      await page.fill('input[name="location"]', user.city);
    }
    if (user.linkedinProfile && (await page.locator('input[name="urls[LinkedIn]"]').count())) {
      await page.fill('input[name="urls[LinkedIn]"]', user.linkedinProfile);
    }
    if (resumeBuffer && (await page.locator('input[name="resume"]').count())) {
      await page.setInputFiles('input[name="resume"]', {
        name: resumeFilename || 'resume.pdf',
        mimeType: 'application/pdf',
        buffer: resumeBuffer,
      });
    }

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

    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const confirmed = /thank you|application (received|submitted)|successfully applied/i.test(bodyText);

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
