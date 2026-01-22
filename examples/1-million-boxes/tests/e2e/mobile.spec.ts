import { expect, test } from "@playwright/test"

// Test mobile layouts on actual device viewports
test.describe(`Mobile Layout`, () => {
  test.use({ viewport: { width: 390, height: 844 } }) // iPhone 13 size

  test.beforeEach(async ({ page }) => {
    await page.goto(`/`)
  })

  test(`mobile layout displays correctly`, async ({ page }) => {
    // Core UI elements should be visible
    await expect(page.getByTestId(`team-badge`)).toBeVisible()
    await expect(page.getByTestId(`quota-meter`)).toBeVisible()

    // World view should be visible
    const worldView = page.locator(`.world-view`)
    await expect(worldView).toBeVisible()

    // Check that world view takes appropriate space
    const box = await worldView.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      // World view should fill most of the screen width
      expect(box.width).toBeGreaterThan(300)
    }
  })

  test(`touch targets are at least 44px`, async ({ page }) => {
    // Apple's Human Interface Guidelines recommend 44px minimum
    const MIN_TOUCH_TARGET = 44

    // Check zoom buttons
    const zoomIn = page.getByRole(`button`, { name: /zoom in/i })
    const zoomOut = page.getByRole(`button`, { name: /zoom out/i })

    for (const button of [zoomIn, zoomOut]) {
      const box = await button.boundingBox()
      expect(box).toBeTruthy()
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET)
        expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET)
      }
    }
  })

  test(`world view is visible on mobile`, async ({ page }) => {
    const worldView = page.locator(`.world-view`)
    await expect(worldView).toBeVisible()

    // Get viewport size
    const viewportSize = page.viewportSize()
    expect(viewportSize).toBeTruthy()

    const box = await worldView.boundingBox()
    expect(box).toBeTruthy()

    if (box && viewportSize) {
      // World view should be within viewport bounds
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewportSize.width + 1)
    }
  })

  test(`no horizontal overflow on mobile`, async ({ page }) => {
    // Check that body doesn't have horizontal scroll
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.body.scrollWidth > window.innerWidth
    })

    expect(hasHorizontalScroll).toBe(false)
  })

  test(`quota meter is accessible on mobile`, async ({ page }) => {
    const quotaMeter = page.getByTestId(`quota-meter`)
    await expect(quotaMeter).toBeVisible()

    const box = await quotaMeter.boundingBox()
    expect(box).toBeTruthy()

    if (box) {
      // Should have reasonable size for mobile viewing
      expect(box.width).toBeGreaterThan(50)
      expect(box.height).toBeGreaterThan(20)
    }
  })

  test(`team badge is readable on mobile`, async ({ page }) => {
    const teamBadge = page.getByTestId(`team-badge`)
    await expect(teamBadge).toBeVisible()

    const teamName = page.getByTestId(`team-name`)
    await expect(teamName).toBeVisible()

    // Check that text is actually visible (has some size)
    const box = await teamName.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.width).toBeGreaterThan(0)
      expect(box.height).toBeGreaterThan(0)
    }
  })
})

// Test on small viewport (iPhone SE size)
test.describe(`Small Mobile Layout`, () => {
  test.use({ viewport: { width: 375, height: 667 } }) // iPhone SE size

  test(`layout adapts to small screen`, async ({ page }) => {
    await page.goto(`/`)

    // UI should still be visible
    await expect(page.getByTestId(`team-badge`)).toBeVisible()
    await expect(page.getByTestId(`quota-meter`)).toBeVisible()

    const worldView = page.locator(`.world-view`)
    await expect(worldView).toBeVisible()
  })

  test(`controls remain accessible`, async ({ page }) => {
    await page.goto(`/`)

    const zoomIn = page.getByRole(`button`, { name: /zoom in/i })
    const zoomOut = page.getByRole(`button`, { name: /zoom out/i })

    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()

    // Should be clickable
    await zoomIn.click()
    await zoomOut.click()
  })
})

// Test landscape orientation
test.describe(`Landscape Orientation`, () => {
  test.use({ viewport: { width: 844, height: 390 } }) // iPhone 13 landscape

  test(`landscape layout works`, async ({ page }) => {
    await page.goto(`/`)

    // Core elements should be visible
    await expect(page.getByTestId(`team-badge`)).toBeVisible()
    await expect(page.getByTestId(`quota-meter`)).toBeVisible()

    const worldView = page.locator(`.world-view`)
    await expect(worldView).toBeVisible()
  })

  test(`world view uses available width in landscape`, async ({ page }) => {
    await page.goto(`/`)

    const worldView = page.locator(`.world-view`)
    const box = await worldView.boundingBox()

    expect(box).toBeTruthy()
    if (box) {
      // In landscape, world view should have substantial width
      expect(box.width).toBeGreaterThan(400)
    }
  })
})

// Test touch interactions
test.describe(`Touch Interactions`, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test(`tap on world view is handled`, async ({ page }) => {
    await page.goto(`/`)

    const worldView = page.locator(`.world-view`)
    await expect(worldView).toBeVisible()

    const box = await worldView.boundingBox()
    expect(box).toBeTruthy()

    if (box) {
      // Tap in the center
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)

      // Verify no errors occurred (page should still be functional)
      await expect(page.getByTestId(`quota-meter`)).toBeVisible()
    }
  })

  test(`zoom buttons respond to touch`, async ({ page }) => {
    await page.goto(`/`)

    const zoomIn = page.getByRole(`button`, { name: /zoom in/i })
    await expect(zoomIn).toBeVisible()

    const box = await zoomIn.boundingBox()
    expect(box).toBeTruthy()

    if (box) {
      // Touch the zoom button
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)

      // Button should still be visible and functional
      await expect(zoomIn).toBeVisible()
    }
  })
})
