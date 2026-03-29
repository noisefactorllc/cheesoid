import { chromium } from 'playwright'

const BASE = 'http://localhost:3001'

let results = []

function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ': ' + detail : ''}`)
}

async function withPage(username, fn) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)
    return await fn(page)
  } finally {
    await browser.close()
  }
}

async function switchTo(page, view) {
  if (view.startsWith('dm:')) {
    const name = view.replace('dm:', '')
    await page.locator(`#participants li[data-name="${name}"]`).click()
  } else {
    await page.locator(`#rooms-list li[data-room="${view}"]`).click()
  }
  await page.waitForTimeout(1500)
}

async function sendMsg(page, text) {
  await page.fill('#input', text)
  await page.click('#send-btn')
}

async function getMessages(page) {
  return (await page.locator('.message-body').allTextContents()).map(t => t.trim()).filter(Boolean)
}

async function waitForText(page, text, timeoutSec = 25) {
  for (let i = 0; i < timeoutSec; i++) {
    await page.waitForTimeout(1000)
    const msgs = await getMessages(page)
    if (msgs.some(m => m.includes(text))) return true
  }
  return false
}

async function hasText(page, text) {
  const msgs = await getMessages(page)
  return msgs.some(m => m.includes(text))
}

// ============================================================
// TESTS
// ============================================================

async function test1_generalRoundTrip() {
  console.log('\n=== 1. #general round-trip ===')
  return withPage('T1User', async (page) => {
    await switchTo(page, '#general')
    const msg = `GEN_RT_${Date.now()}`
    await sendMsg(page, msg)
    const found = await waitForText(page, msg, 10)
    record('#general: sent message visible', found)
    // Wait for agent response
    let resp = false
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000)
      const msgs = await getMessages(page)
      resp = msgs.some(m => !m.includes(msg) && m.length > 0)
      if (resp) break
    }
    record('#general: agent responded', resp)
    return { msg, pass: found && resp }
  })
}

async function test2_testRoundTrip() {
  console.log('\n=== 2. #test round-trip ===')
  return withPage('T2User', async (page) => {
    await switchTo(page, '#test')
    const msg = `TEST_RT_${Date.now()}`
    await sendMsg(page, msg)
    const found = await waitForText(page, msg, 15)
    record('#test: sent message visible', found)
    let resp = false
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000)
      const msgs = await getMessages(page)
      resp = msgs.some(m => !m.includes(msg) && m.length > 0)
      if (resp) break
    }
    record('#test: agent responded', resp)
    return { msg, pass: found && resp }
  })
}

async function test3_channelIsolation(genMsg, testMsg) {
  console.log('\n=== 3. Channel isolation ===')
  return withPage('T3User', async (page) => {
    // Check #general doesn't have #test messages
    await switchTo(page, '#general')
    await page.waitForTimeout(2000)
    const genHasTest = await hasText(page, testMsg)
    record('#general does NOT contain #test msg', !genHasTest)

    // Check #test doesn't have #general messages
    await switchTo(page, '#test')
    await page.waitForTimeout(2000)
    const testHasGen = await hasText(page, genMsg)
    record('#test does NOT contain #general msg', !testHasGen)

    // Check #test DOES have its own messages
    const testHasOwn = await hasText(page, testMsg)
    record('#test contains its own msg', testHasOwn)

    return { pass: !genHasTest && !testHasGen && testHasOwn }
  })
}

async function test4_dmToHost() {
  console.log('\n=== 4. DM to host (Red) ===')
  return withPage('T4User', async (page) => {
    await switchTo(page, 'dm:Red')
    const msg = `DM_HOST_${Date.now()}`
    await sendMsg(page, msg)
    const found = await waitForText(page, msg, 10)
    record('DM to Red: sent visible', found)
    let resp = false
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000)
      const msgs = await getMessages(page)
      resp = msgs.some(m => !m.includes(msg) && m.length > 0)
      if (resp) break
    }
    record('DM to Red: response received', resp)
    return { msg, pass: found && resp }
  })
}

async function test5_dmToVisitor() {
  console.log('\n=== 5. DM to visitor (Green) ===')
  return withPage('T5User', async (page) => {
    await switchTo(page, 'dm:Green')
    const msg = `DM_VIS_${Date.now()}`
    await sendMsg(page, msg)
    const found = await waitForText(page, msg, 10)
    record('DM to Green: sent visible', found)
    // Wait for more than 1 message (sent + response)
    let resp = false
    const msgCountBefore = (await getMessages(page)).length
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000)
      const msgs = await getMessages(page)
      if (msgs.length > msgCountBefore) {
        resp = true
        break
      }
    }
    record('DM to Green: response received', resp)
    return { msg, pass: found && resp }
  })
}

async function test6_dmPrivacy(dmHostMsg, dmVisitorMsg) {
  console.log('\n=== 6. DM privacy ===')
  return withPage('T6Spy', async (page) => {
    // Spy checks dm:Red — should NOT see T4User's DM
    await switchTo(page, 'dm:Red')
    await page.waitForTimeout(2000)
    const spySeesHostDM = await hasText(page, dmHostMsg)
    record('Spy cannot see T4User DM to Red', !spySeesHostDM)

    // Spy checks dm:Green — should NOT see T5User's DM
    await switchTo(page, 'dm:Green')
    await page.waitForTimeout(2000)
    const spySeesVisDM = await hasText(page, dmVisitorMsg)
    record('Spy cannot see T5User DM to Green', !spySeesVisDM)

    // Check #general
    await switchTo(page, '#general')
    await page.waitForTimeout(2000)
    const genHasHostDM = await hasText(page, dmHostMsg)
    const genHasVisDM = await hasText(page, dmVisitorMsg)
    record('DM to Red not in #general', !genHasHostDM)
    record('DM to Green not in #general', !genHasVisDM)

    // Check #test
    await switchTo(page, '#test')
    await page.waitForTimeout(2000)
    const testHasHostDM = await hasText(page, dmHostMsg)
    const testHasVisDM = await hasText(page, dmVisitorMsg)
    record('DM to Red not in #test', !testHasHostDM)
    record('DM to Green not in #test', !testHasVisDM)

    return { pass: !spySeesHostDM && !spySeesVisDM && !genHasHostDM && !genHasVisDM && !testHasHostDM && !testHasVisDM }
  })
}

async function test7_persistence(genMsg, testMsg, dmHostMsg) {
  console.log('\n=== 7. Persistence after reload ===')
  return withPage('T7User', async (page) => {
    // #general should have genMsg
    await switchTo(page, '#general')
    await page.waitForTimeout(2000)
    const genPersist = await hasText(page, genMsg)
    record('#general msg persists', genPersist)

    // #test should have testMsg
    await switchTo(page, '#test')
    await page.waitForTimeout(2000)
    const testPersist = await hasText(page, testMsg)
    record('#test msg persists', testPersist)

    // #general should NOT have testMsg
    await switchTo(page, '#general')
    await page.waitForTimeout(2000)
    const genClean = !(await hasText(page, testMsg))
    record('#general still clean of #test msgs', genClean)

    return { pass: genPersist && testPersist && genClean }
  })
}

async function test8_agentResponseRoom() {
  console.log('\n=== 8. Agent response appears in correct room only ===')
  const browser1 = await chromium.launch({ headless: true })
  const browser2 = await chromium.launch({ headless: true })
  const pageGen = await browser1.newPage()
  const pageTest = await browser2.newPage()

  try {
    // User A on #general
    await pageGen.goto(BASE)
    await pageGen.fill('#name-input', 'T8Gen')
    await pageGen.click('#name-btn')
    await pageGen.waitForSelector('#messages', { state: 'visible' })
    await pageGen.waitForTimeout(3000)

    // User B on #test
    await pageTest.goto(BASE)
    await pageTest.fill('#name-input', 'T8Test')
    await pageTest.click('#name-btn')
    await pageTest.waitForSelector('#messages', { state: 'visible' })
    await pageTest.waitForTimeout(3000)
    await switchTo(pageTest, '#test')

    // Clear what's on screen
    const genBefore = await getMessages(pageGen)
    const testBefore = await getMessages(pageTest)

    // Send from #test
    const msg = `ROOM_CHECK_${Date.now()}`
    await sendMsg(pageTest, msg)
    await pageTest.waitForTimeout(15000)

    // Check #test has the message
    const testHas = (await getMessages(pageTest)).some(m => m.includes(msg))
    record('#test sees its own message', testHas)

    // Check #general does NOT have new messages containing msg
    const genAfter = await getMessages(pageGen)
    const genNew = genAfter.filter(m => !genBefore.includes(m))
    const genHas = genNew.some(m => m.includes(msg))
    if (genHas) {
      console.log(`  LEAK DETAIL: found "${msg}" in #general new messages:`)
      for (const m of genNew.filter(m => m.includes(msg))) {
        console.log(`    "${m.slice(0, 120)}"`)
      }
      // Dump all new messages to see what appeared
      console.log(`  ALL NEW in #general (${genNew.length}):`)
      for (const m of genNew) console.log(`    "${m.slice(0, 100)}"`)
      // Check page source for the message
      const html = await pageGen.locator('#messages').innerHTML()
      const idx = html.indexOf(msg)
      if (idx >= 0) {
        console.log(`  HTML context: ...${html.slice(Math.max(0, idx - 100), idx + 100)}...`)
      }
    }
    record('#general does NOT see #test message', !genHas)

    // Check for agent response leaking
    const genHasResponse = genNew.some(m => !m.includes(msg) && m.includes('ROOM_CHECK'))
    record('#general does NOT see #test agent response', !genHasResponse)

    return { pass: testHas && !genHas && !genHasResponse }
  } finally {
    await browser1.close()
    await browser2.close()
  }
}

async function main() {
  console.log('=== COMPREHENSIVE ROUTING TEST SUITE ===')

  const t1 = await test1_generalRoundTrip()
  const t2 = await test2_testRoundTrip()
  const t3 = await test3_channelIsolation(t1.msg, t2.msg)
  const t4 = await test4_dmToHost()
  const t5 = await test5_dmToVisitor()
  const t6 = await test6_dmPrivacy(t4.msg, t5.msg)
  const t7 = await test7_persistence(t1.msg, t2.msg, t4.msg)
  const t8 = await test8_agentResponseRoom()

  console.log('\n========================================')
  console.log('=== RESULTS ===')
  console.log('========================================')
  const allPass = results.every(r => r.pass)
  for (const r of results) {
    console.log(`${r.pass ? '✓' : '✗'} ${r.name}`)
  }
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`)
  console.log(allPass ? '\n*** ALL TESTS PASS ***' : '\n*** FAILURES DETECTED ***')

  process.exit(allPass ? 0 : 1)
}

main()
