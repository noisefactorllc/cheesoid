// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000'

test('DM messages are visible after sending', async ({ page }) => {
  // Collect console logs for debugging
  const consoleLogs = []
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))

  await page.goto(BASE)

  // Enter name
  await page.fill('#name-input', 'DMTest')
  await page.click('#name-btn')

  // Wait for chat to load
  await page.waitForSelector('#messages', { state: 'visible' })
  await page.waitForTimeout(3000)

  // Take pre-DM screenshot
  await page.screenshot({ path: 'tests/dm-debug-1-room.png', fullPage: true })

  // Find the host agent in participant list and click to open DM view
  const hostParticipant = page.locator('#participants li').first()
  await expect(hostParticipant).toBeVisible({ timeout: 10000 })
  const hostName = await hostParticipant.textContent()
  await hostParticipant.click()

  // Verify we're in the DM view
  await expect(page.locator('#channel-name')).toHaveText(hostName.trim())

  // Take screenshot of empty DM view
  await page.screenshot({ path: 'tests/dm-debug-2-dm-view.png', fullPage: true })

  // Check what messages are visible right now (scrollback DMs)
  const messagesBeforeSend = await page.locator('#messages .message').count()
  console.log(`Messages visible before send: ${messagesBeforeSend}`)

  // Send a DM
  const testMsg = `DM visibility test ${Date.now()}`
  await page.fill('#input', testMsg)
  await page.click('#send-btn')

  // Wait a moment for the message to render
  await page.waitForTimeout(2000)

  // Take screenshot after sending
  await page.screenshot({ path: 'tests/dm-debug-3-after-send.png', fullPage: true })

  // Check if the sent message is visible
  const sentMsg = page.locator('.message-body', { hasText: testMsg })
  const sentCount = await sentMsg.count()
  console.log(`Sent message visible: ${sentCount > 0}`)

  // Count all messages now
  const messagesAfterSend = await page.locator('#messages .message').count()
  console.log(`Messages visible after send: ${messagesAfterSend}`)

  // Check innerHTML of messages container
  const messagesHtml = await page.locator('#messages').innerHTML()
  console.log(`Messages container innerHTML length: ${messagesHtml.length}`)
  if (messagesHtml.length < 500) {
    console.log(`Messages HTML: ${messagesHtml}`)
  }

  // Dump relevant JS state
  const state = await page.evaluate(() => {
    /* eslint-disable no-undef */
    return {
      currentView: typeof currentView !== 'undefined' ? currentView : 'undefined',
      hubMode: typeof hubMode !== 'undefined' ? hubMode : 'undefined',
      myName: typeof myName !== 'undefined' ? myName : 'undefined',
      personaLabel: typeof personaLabel !== 'undefined' ? personaLabel : 'undefined',
    }
  })
  console.log('Frontend state:', JSON.stringify(state))

  // Print console logs
  console.log('\n--- Browser console logs ---')
  for (const log of consoleLogs) {
    console.log(log)
  }

  // THE ASSERTION: the sent message must be visible
  await expect(sentMsg).toBeVisible({ timeout: 5000 })
})
