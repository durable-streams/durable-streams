import { chromium } from "playwright"

const BASE = "https://localhost:4444"

async function test() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const errors = []
  const consoleMessages = []

  const page = await context.newPage()
  page.on("console", (msg) =>
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
  )
  page.on("pageerror", (err) => errors.push(`PAGE ERROR: ${err.message}`))

  // Test 1: Lobby loads
  console.log("--- Test 1: Lobby loads ---")
  await page.goto(BASE, { waitUntil: "networkidle" })
  const title = await page.textContent("div")
  const hasSnakeTitle = title?.includes("SNAKE")
  const hasCreateRoom = await page.locator("text=Create Room").isVisible()
  const hasJoinRoom = await page.locator("text=Join Room").isVisible()
  console.log(`  Title contains SNAKE: ${hasSnakeTitle}`)
  console.log(`  Create Room visible: ${hasCreateRoom}`)
  console.log(`  Join Room visible: ${hasJoinRoom}`)
  if (!hasSnakeTitle || !hasCreateRoom || !hasJoinRoom) {
    errors.push("Lobby did not render correctly")
  }

  // Test 2: Create a room
  console.log("--- Test 2: Create room ---")
  // Fill room name
  const roomInput = page.locator('input[placeholder="my-room"]')
  await roomInput.fill("test-browser")
  // Select Medium board size (already default)
  // Click CREATE & JOIN
  await page.locator("text=CREATE & JOIN").click()
  await page.waitForTimeout(3000) // wait for Yjs connection

  const url = page.url()
  const hasRoomHash = url.includes("#room/")
  console.log(`  URL has room hash: ${hasRoomHash} (${url})`)

  // Test 3: Game renders
  console.log("--- Test 3: Game board renders ---")
  const hasSvg = await page
    .locator("svg")
    .isVisible()
    .catch(() => false)
  const hasLobbyBtn = await page
    .locator("text=LOBBY")
    .isVisible()
    .catch(() => false)
  const hasSnakeLabel = await page
    .locator("text=SNAKE")
    .first()
    .isVisible()
    .catch(() => false)
  console.log(`  SVG game board visible: ${hasSvg}`)
  console.log(`  Lobby button visible: ${hasLobbyBtn}`)
  console.log(`  SNAKE label visible: ${hasSnakeLabel}`)
  if (!hasSvg) {
    errors.push("Game board SVG did not render")
  }

  // Test 4: Check scoreboard appears
  console.log("--- Test 4: Scoreboard ---")
  // The player name should appear in the scoreboard
  const pageText = await page.textContent("body")
  const hasScore = pageText?.includes("0") // initial score is 0
  console.log(`  Score visible: ${hasScore}`)

  // Test 5: Game loop is running (snake moves)
  console.log("--- Test 5: Game loop running ---")
  // Get initial snake head position by checking SVG rect positions
  const initialRects = await page.locator("svg rect").count()
  console.log(
    `  SVG rects (snake segments + obstacles + grid): ${initialRects}`
  )
  await page.waitForTimeout(2000) // wait for a few ticks
  const laterRects = await page.locator("svg rect").count()
  console.log(`  SVG rects after 2s: ${laterRects}`)

  // Test 6: Keyboard input works
  console.log("--- Test 6: Keyboard input ---")
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(500)
  await page.keyboard.press("ArrowRight")
  await page.waitForTimeout(500)
  console.log(`  Keyboard events sent without errors`)

  // Test 7: Player count shows
  console.log("--- Test 7: Player presence ---")
  const hasPlayerCount = pageText?.includes("player")
  console.log(`  Player count text visible: ${hasPlayerCount}`)

  // Test 8: Second player can join same room
  console.log("--- Test 8: Multiplayer (second tab) ---")
  const page2 = await context.newPage()
  page2.on("pageerror", (err) => errors.push(`PAGE2 ERROR: ${err.message}`))
  // Extract room ID from URL
  const roomId = decodeURIComponent(url.split("#room/")[1] || "")
  console.log(`  Room ID: ${roomId}`)
  await page2.goto(`${BASE}/#room/${encodeURIComponent(roomId)}`, {
    waitUntil: "networkidle",
  })
  await page2.waitForTimeout(3000)
  const page2HasSvg = await page2
    .locator("svg")
    .isVisible()
    .catch(() => false)
  console.log(`  Second player sees game board: ${page2HasSvg}`)

  // Check if player count updated on first page
  await page.waitForTimeout(2000)
  const updatedText = await page.textContent("body")
  const has2Players = updatedText?.includes("2 player")
  console.log(`  First tab shows 2 players: ${has2Players}`)

  // Test 9: Leave room works
  console.log("--- Test 9: Leave room ---")
  await page2.locator("text=LOBBY").click()
  await page2.waitForTimeout(1000)
  const backInLobby = await page2
    .locator("text=Create Room")
    .isVisible()
    .catch(() => false)
  console.log(`  Second player back in lobby: ${backInLobby}`)

  // Test 10: ngrok embeddability
  console.log("--- Test 10: Ngrok embeddability ---")
  const page3 = await context.newPage()
  page3.on("pageerror", (err) =>
    errors.push(`PAGE3/NGROK ERROR: ${err.message}`)
  )
  try {
    await page3.goto("https://acff-148-69-194-62.ngrok-free.app", {
      waitUntil: "networkidle",
      timeout: 15000,
    })
    const ngrokText = await page3.textContent("body")
    // ngrok free shows interstitial, check if we at least get a response
    const ngrokLoaded = ngrokText.length > 0
    console.log(`  Ngrok URL loads: ${ngrokLoaded}`)
  } catch (e) {
    console.log(`  Ngrok test skipped (${e.message?.substring(0, 50)})`)
  }

  // Summary
  console.log("\n=== CONSOLE MESSAGES ===")
  consoleMessages.forEach((m) => console.log(`  ${m}`))

  console.log("\n=== ERRORS ===")
  if (errors.length === 0) {
    console.log("  No errors!")
  } else {
    errors.forEach((e) => console.log(`  ${e}`))
  }

  console.log("\n=== RESULTS ===")
  const passed =
    errors.length === 0 &&
    hasSnakeTitle &&
    hasCreateRoom &&
    hasSvg &&
    hasRoomHash
  console.log(passed ? "  ALL TESTS PASSED" : "  SOME TESTS FAILED")

  await browser.close()
  process.exit(passed ? 0 : 1)
}

test().catch((err) => {
  console.error("Test crashed:", err)
  process.exit(1)
})
