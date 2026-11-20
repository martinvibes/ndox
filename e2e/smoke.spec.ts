import { expect, test } from '@playwright/test';
import { E2E_PASSWORD } from './env.js';

test('home shows the four sites and an honestly labelled pool', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Quand la mer dit non');
  for (const site of ['kayar', 'saint-louis', 'joal', 'soumbedioune'])
    await expect(page.getByTestId(`status-${site}`)).toBeVisible();
  await expect(page.getByText('Simulé').first()).toBeVisible();
});

test('a replayed attestation passes every check in the browser', async ({ page }) => {
  await page.goto('/verifier');
  await page.getByRole('tab', { name: 'Rejeux' }).click();
  await page.getByRole('link', { name: 'Contrôler' }).first().click();
  const summary = page.getByTestId('verify-summary');
  await expect(summary).toHaveAttribute('data-done', 'true', { timeout: 20_000 });
  await expect(summary).toHaveAttribute('data-failed', 'false');
  await expect(summary).toHaveText('Tous les contrôles sont passés.');

  await page.getByRole('button', { name: /avec le même R/ }).click();
  await expect(page.getByTestId('equivocation-result')).toBeVisible();
});

test('a sponsor pays a simulated invoice and gets a receipt', async ({ page }) => {
  await page.goto('/soutenir');
  await page.getByRole('button', { name: 'Créer la demande de paiement' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveAttribute('data-status', 'pending');
  await page.getByRole('button', { name: 'Simuler le paiement' }).click();
  await expect(page.getByTestId('sponsor-thanks')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Voir le reçu' }).click();
  await expect(page.getByRole('heading', { name: 'Reçu de don' })).toBeVisible();
});

test('the council replays an alert day and pays the demo crews', async ({ page }) => {
  await page.goto('/conseil/rejeu');
  await page.getByLabel('Mot de passe').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByTestId('replay-run').click();
  await expect(page.getByTestId('replay-outcome')).toHaveText(/danger/i, { timeout: 20_000 });
  await expect(page.getByText('Signature vérifiée')).toBeVisible();
  await expect(page.getByTestId('replay-total')).toContainText('FCFA', { timeout: 10_000 });
  await expect(page.getByTestId('replay-sms')).toContainText(/^NDOX .+ Code: [A-Z0-9]{6}$/, {
    timeout: 10_000,
  });
});
