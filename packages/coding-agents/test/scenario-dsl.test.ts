import { describe, expect, it } from "vitest"
import { scenario } from "./scenario-dsl.js"

describe(`scenario DSL`, () => {
  it(`serializes prompts and keeps only one prompt in flight`, async () => {
    const result = await scenario(`serializes prompts`)
      .scriptedAgent(`claude`)
      .client(`alice`)
      .client(`bob`)
      .useClient(`alice`)
      .prompt(`first`)
      .useClient(`bob`)
      .prompt(`second`)
      .waitForForwardedCount((event) => event.source === `queued_prompt`, 1)
      .injectAgent({
        type: `assistant`,
        message: {
          content: [{ type: `text`, text: `first done` }],
        },
      })
      .injectAgent({
        type: `result`,
        subtype: `success`,
      })
      .waitForForwardedCount((event) => event.source === `queued_prompt`, 2)
      .injectAgent({
        type: `assistant`,
        message: {
          content: [{ type: `text`, text: `second done` }],
        },
      })
      .injectAgent({
        type: `result`,
        subtype: `success`,
      })
      .expectAssistantMessage(/second done/)
      .expectForwardedCount((event) => event.source === `queued_prompt`, 2)
      .expectInvariant(`single_in_flight_prompt`)
      .expectInvariant(`bridge_lifecycle_well_formed`)
      .run()

    const promptTexts = result.forwardedMessages
      .filter((event) => event.source === `queued_prompt`)
      .map((event) => {
        const raw = event.raw as Record<string, unknown>
        if (typeof raw.text === `string`) {
          return raw.text
        }

        const message = raw.message as Record<string, unknown> | undefined
        if (typeof message?.content === `string`) {
          return message.content
        }

        return undefined
      })

    expect(promptTexts).toEqual([
      [
        `[Current speaker]`,
        `name: alice`,
        `email: alice@example.com`,
        `Interpret first-person references like "I", "me", "my", "mine", "we", and "our" as referring to this speaker unless the message says otherwise.`,
        ``,
        `[User message]`,
        `first`,
      ].join(`\n`),
      [
        `[Current speaker]`,
        `name: bob`,
        `email: bob@example.com`,
        `Interpret first-person references like "I", "me", "my", "mine", "we", and "our" as referring to this speaker unless the message says otherwise.`,
        ``,
        `[User message]`,
        `second`,
      ].join(`\n`),
    ])
  })

  it(`deduplicates competing client responses`, async () => {
    const result = await scenario(`deduplicates responses`)
      .scriptedAgent(`claude`)
      .client(`alice`)
      .client(`bob`)
      .injectAgent({
        type: `control_request`,
        request_id: `perm-1`,
        request: {
          subtype: `can_use_tool`,
          tool_name: `Bash`,
          input: { command: `npm test` },
        },
      })
      .waitForPermissionRequest(`Bash`)
      .useClient(`alice`)
      .respondToLatestPermissionRequest(
        { behavior: `allow` },
        { matcher: `Bash` }
      )
      .useClient(`bob`)
      .respond(`perm-1`, { behavior: `deny` })
      .waitForForwardedCount((event) => event.source === `client_response`, 1)
      .expectPermissionRequest(`Bash`)
      .expectForwardedCount((event) => event.source === `client_response`, 1)
      .expectInvariant(`first_response_wins`)
      .expectInvariant(`bridge_lifecycle_well_formed`)
      .run()

    const forwardedResponse = result.forwardedMessages.find(
      (event) => event.source === `client_response`
    )

    expect(forwardedResponse).toBeDefined()
    expect(
      (forwardedResponse?.raw as Record<string, unknown>).response
    ).toEqual({
      request_id: `perm-1`,
      subtype: `success`,
      response: { behavior: `allow` },
    })
  })

  it(`can cancel the latest permission request without a hard-coded request id`, async () => {
    const result = await scenario(`cancel latest permission request`)
      .scriptedAgent(`claude`)
      .client(`alice`)
      .injectAgent({
        type: `control_request`,
        request_id: `perm-2`,
        request: {
          subtype: `can_use_tool`,
          tool_name: `Bash`,
          input: { command: `rm -rf /tmp/nope` },
        },
      })
      .waitForPermissionRequest(`Bash`)
      .cancelLatestPermissionRequest({ matcher: `Bash` })
      .waitForForwardedCount((event) => event.source === `client_response`, 1)
      .expectForwardedCount((event) => event.source === `client_response`, 1)
      .run()

    const forwardedResponse = result.forwardedMessages.find(
      (event) => event.source === `client_response`
    )

    expect(
      (forwardedResponse?.raw as Record<string, unknown>).response
    ).toEqual({
      request_id: `perm-2`,
      subtype: `cancelled`,
      response: {},
    })
  })

  it(`forwards structured AskUserQuestion responses`, async () => {
    const questions = [
      {
        question: `What are you looking to work on?`,
        header: `Task`,
        options: [
          { label: `Bug fix`, description: `Fix an issue in the codebase` },
          {
            label: `New feature`,
            description: `Add new functionality`,
          },
        ],
        multiSelect: false,
      },
    ]

    const result = await scenario(`ask user question response`)
      .scriptedAgent(`claude`)
      .client(`alice`)
      .injectAgent({
        type: `control_request`,
        request_id: `ask-1`,
        request: {
          subtype: `can_use_tool`,
          tool_name: `AskUserQuestion`,
          input: { questions },
        },
      })
      .waitForPermissionRequest(`AskUserQuestion`)
      .respondToLatestPermissionRequest(
        {
          behavior: `allow`,
          updatedInput: {
            questions,
            answers: {
              "What are you looking to work on?": `Bug fix`,
            },
          },
        },
        { matcher: `AskUserQuestion` }
      )
      .waitForForwardedCount((event) => event.source === `client_response`, 1)
      .expectForwardedCount((event) => event.source === `client_response`, 1)
      .run()

    const forwardedResponse = result.forwardedMessages.find(
      (event) => event.source === `client_response`
    )

    expect(
      (forwardedResponse?.raw as Record<string, unknown>).response
    ).toEqual({
      request_id: `ask-1`,
      subtype: `success`,
      response: {
        behavior: `allow`,
        updatedInput: {
          questions,
          answers: {
            "What are you looking to work on?": `Bug fix`,
          },
        },
      },
    })
  })

  it(`supports restart and resume scenarios`, async () => {
    const result = await scenario(`restart and resume`)
      .scriptedAgent(`claude`)
      .client(`kyle`)
      .prompt(`before restart`)
      .injectAgent({
        type: `assistant`,
        message: {
          content: [{ type: `text`, text: `before restart done` }],
        },
      })
      .injectAgent({
        type: `result`,
        subtype: `success`,
      })
      .restart()
      .prompt(`after restart`)
      .injectAgent({
        type: `assistant`,
        message: {
          content: [{ type: `text`, text: `after restart done` }],
        },
      })
      .injectAgent({
        type: `result`,
        subtype: `success`,
      })
      .expectBridgeEvent(`session_started`, { count: 1 })
      .expectBridgeEvent(`session_resumed`, { count: 1 })
      .expectBridgeEvent(`session_ended`, { count: 2 })
      .expectInvariant(`bridge_lifecycle_well_formed`)
      .run()

    const bridgeEventTypes = result.history
      .filter((event) => event.direction === `bridge`)
      .map((event) => (event as { type: string }).type)

    expect(bridgeEventTypes).toEqual([
      `session_started`,
      `session_ended`,
      `session_resumed`,
      `session_ended`,
    ])
  })
})
