// @ts-check
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3001'

test('DM round-trip to host agent (Red)', async ({ page }) => {
  // Go to cheesoid UI
  await page.goto(BASE)

  // Enter name
  await page.fill('#name-input', 'PlaywrightTest')
  await page.click('#name-btn')

  // Wait for chat to load and scrollback to arrive
  await page.waitForSelector('#messages', { state: 'visible' })
  await page.waitForTimeout(3000)

  // Click Red in participant list to open DM view
  const redParticipant = page.locator('#participants li', { hasText: 'Red' })
  await expect(redParticipant).toBeVisible({ timeout: 10000 })
  await redParticipant.click()

  // Verify we're in dm:Red view — channel label should show "Red"
  await expect(page.locator('#channel-name')).toHaveText('Red')

  // Send a DM
  await page.fill('#input', 'Playwright DM test to Red')
  await page.click('#send-btn')

  // Wait for our sent message to appear
  const sentMsg = page.locator('.message-body', { hasText: 'Playwright DM test to Red' })
  await expect(sentMsg).toBeVisible({ timeout: 10000 })

  // Wait for Red's response — it should appear as an assistant message
  // Red needs time to process (LLM call), give it up to 60 seconds
  const response = page.locator('.message-body').filter({
    hasNotText: 'Playwright DM test to Red'
  }).last()
  await expect(response).toBeVisible({ timeout: 60000 })

  // Verify the response contains actual text (not empty)
  const responseText = await response.textContent()
  expect(responseText.trim().length).toBeGreaterThan(0)
  console.log('Red DM response:', responseText.trim())

  // Take screenshot as evidence
  await page.screenshot({ path: 'tests/dm-roundtrip-red.png', fullPage: true })
})

test('DM round-trip to visitor agent (Green)', async ({ page }) => {
  await page.goto(BASE)

  await page.fill('#name-input', 'PlaywrightTest2')
  await page.click('#name-btn')

  await page.waitForSelector('#messages', { state: 'visible' })
  await page.waitForTimeout(3000)

  // Click Green in participant list
  const greenParticipant = page.locator('#participants li', { hasText: 'Green' })
  await expect(greenParticipant).toBeVisible({ timeout: 10000 })
  await greenParticipant.click()

  await expect(page.locator('#channel-name')).toHaveText('Green')

  // Send DM to Green
  await page.fill('#input', 'Playwright DM test to Green')
  await page.click('#send-btn')

  const sentMsg = page.locator('.message-body', { hasText: 'Playwright DM test to Green' })
  await expect(sentMsg).toBeVisible({ timeout: 10000 })

  // Wait for Green's response — up to 90 seconds (visitor DM goes through host relay)
  const response = page.locator('.message-body').filter({
    hasNotText: 'Playwright DM test to Green'
  }).last()
  await expect(response).toBeVisible({ timeout: 90000 })

  const responseText = await response.textContent()
  expect(responseText.trim().length).toBeGreaterThan(0)
  console.log('Green DM response:', responseText.trim())

  await page.screenshot({ path: 'tests/dm-roundtrip-green.png', fullPage: true })
})
