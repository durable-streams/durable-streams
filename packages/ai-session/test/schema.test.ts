import { describe, expect, it } from "vitest"
import {
  MessageSchema,
  DeltaSchema,
  PresenceSchema,
  AgentSchema,
  aiSessionSchema,
  generateMessageId,
  generateDeltaId,
  generatePresenceId,
} from "../src/schema.js"

describe("AI Session Schema", () => {
  describe("MessageSchema", () => {
    it("validates a valid message", () => {
      const message = {
        id: "msg_123",
        role: "assistant" as const,
        agentId: "claude",
        userId: null,
        createdAt: Date.now(),
      }

      const result = MessageSchema.safeParse(message)
      expect(result.success).toBe(true)
    })

    it("rejects invalid role", () => {
      const message = {
        id: "msg_123",
        role: "invalid",
        agentId: "claude",
        userId: null,
        createdAt: Date.now(),
      }

      const result = MessageSchema.safeParse(message)
      expect(result.success).toBe(false)
    })
  })

  describe("DeltaSchema", () => {
    it("validates a text delta", () => {
      const delta = {
        id: "msg_123_p0_s0",
        messageId: "msg_123",
        partIndex: 0,
        partType: "text" as const,
        seq: 0,
        text: "Hello",
      }

      const result = DeltaSchema.safeParse(delta)
      expect(result.success).toBe(true)
    })

    it("validates a tool-call delta", () => {
      const delta = {
        id: "msg_123_p1_s0",
        messageId: "msg_123",
        partIndex: 1,
        partType: "tool-call" as const,
        seq: 0,
        toolCallId: "tc_1",
        toolName: "get_weather",
      }

      const result = DeltaSchema.safeParse(delta)
      expect(result.success).toBe(true)
    })

    it("validates a done delta", () => {
      const delta = {
        id: "msg_123_p0_s5",
        messageId: "msg_123",
        partIndex: 0,
        partType: "text" as const,
        seq: 5,
        done: true,
      }

      const result = DeltaSchema.safeParse(delta)
      expect(result.success).toBe(true)
    })
  })

  describe("PresenceSchema", () => {
    it("validates presence", () => {
      const presence = {
        id: "agent_claude",
        type: "agent" as const,
        name: "Claude",
        status: "active" as const,
        lastSeen: Date.now(),
      }

      const result = PresenceSchema.safeParse(presence)
      expect(result.success).toBe(true)
    })
  })

  describe("AgentSchema", () => {
    it("validates an agent", () => {
      const agent = {
        id: "claude",
        name: "Claude",
        model: "claude-sonnet-4-20250514",
      }

      const result = AgentSchema.safeParse(agent)
      expect(result.success).toBe(true)
    })
  })

  describe("aiSessionSchema", () => {
    it("has all collections", () => {
      expect(aiSessionSchema.messages).toBeDefined()
      expect(aiSessionSchema.deltas).toBeDefined()
      expect(aiSessionSchema.presence).toBeDefined()
      expect(aiSessionSchema.agents).toBeDefined()
    })

    it("creates insert events", () => {
      const event = aiSessionSchema.messages.insert({
        value: {
          id: "msg_1",
          role: "user",
          agentId: null,
          userId: "user_1",
          createdAt: Date.now(),
        },
      })

      expect(event.type).toBe("message")
      expect(event.key).toBe("msg_1")
      expect(event.headers.operation).toBe("insert")
    })
  })

  describe("ID generators", () => {
    it("generates unique message IDs", () => {
      const id1 = generateMessageId()
      const id2 = generateMessageId()
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^msg_\d+_\d+$/)
    })

    it("generates delta IDs from message/part/seq", () => {
      const id = generateDeltaId("msg_123", 0, 5)
      expect(id).toBe("msg_123_p0_s5")
    })

    it("generates presence IDs", () => {
      expect(generatePresenceId("agent", "claude")).toBe("agent_claude")
      expect(generatePresenceId("user", "kyle")).toBe("user_kyle")
    })
  })
})
