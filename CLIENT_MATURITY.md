# Client Library Maturity Model

Durable Streams clients follow a maturity progression that helps users understand the readiness of each implementation and guides contributors on how to help.

## Maturity Levels

### Level 1: Vibe-Engineered

Initial implementation, typically AI-assisted or created rapidly to prove out the API surface.

**Criteria:**

- Implements core protocol operations (create, append, read, delete, head)
- Passes the client conformance test suite
- Has basic documentation (README with installation and usage examples)
- Published to the language's package registry

**What this means for users:**

- API may change based on ecosystem feedback
- Suitable for prototyping and non-critical workloads
- May have rough edges or non-idiomatic patterns
- Community feedback actively sought

**How to level up:**

- Get a language/ecosystem expert to review the implementation
- Incorporate idiomatic patterns and best practices
- Address any API ergonomics issues

---

### Level 2: Expert-Reviewed

A language or ecosystem expert has reviewed and improved the implementation.

**Criteria:**

- All Level 1 criteria, plus:
- Reviewed by someone with significant experience in the language ecosystem
- API follows language-specific idioms and conventions
- Error handling follows ecosystem best practices
- Documentation includes idiomatic examples
- Performance characteristics are reasonable for the ecosystem

**What this means for users:**

- API is stable and idiomatic
- Suitable for production use with appropriate testing
- Implementation quality is on par with other ecosystem libraries
- Maintainers understand the language deeply enough to handle issues

**How to level up:**

- Get adoption from real-world users
- Address issues and feedback from production usage
- Build a track record of stability

---

### Level 3: Production-Proven

Widespread usage in production environments with a track record of stability.

**Criteria:**

- All Level 2 criteria, plus:
- Used in production by multiple organizations
- Has survived real-world edge cases and failure modes
- Stable API with semantic versioning
- Responsive maintenance (issues addressed, security patches)
- May have framework integrations (e.g., Express middleware, Django adapter)

**What this means for users:**

- Battle-tested implementation
- Confident choice for critical workloads
- Active community and maintenance
- Long-term support expectations

---

## Current Client Status

| Client         | Level                 | Package                                                                                       | Conformance | Notes                                                            |
| -------------- | --------------------- | --------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| **TypeScript** | 3 - Production-Proven | [@durable-streams/client](https://www.npmjs.com/package/@durable-streams/client)              | 110/110     | Reference implementation. 1.5+ years production use at Electric. |
| **Python**     | 2 - Expert-Reviewed   | [durable-streams](https://pypi.org/project/durable-streams/)                                  | 110/110     | Async and sync APIs. Reviewed for Pythonic patterns.             |
| **Go**         | 2 - Expert-Reviewed   | [client-go](https://pkg.go.dev/github.com/durable-streams/durable-streams/packages/client-go) | 110/110     | Google Cloud style API. Zero external dependencies.              |
| **Java**       | 1 - Vibe-Engineered   | [durable-streams-java](https://github.com/Clickin/durable-streams-java)                       | TBD         | Community contribution. Framework adapters included.             |

### Planned Clients

Based on analysis of client library adoption across Kafka, Redis Streams, NATS, Pulsar, and Kinesis ecosystems:

| Language    | Priority | Rationale                                                                                                        |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| **Rust**    | High     | Systems programming crowd, signals "serious infrastructure." NATS has official support, growing Kafka community. |
| **C#/.NET** | High     | ~29% professional usage, every major streaming platform has official support. Microsoft/Azure ecosystem.         |
| **Ruby**    | Medium   | ~5% web apps, strong in DevOps/infrastructure tooling. Good for ops scripts consuming streams.                   |
| **PHP**     | Medium   | Powers 75%+ of server-side web. Large surface area for webhook-to-stream and legacy integration.                 |
| **Elixir**  | Medium   | NATS has official support. Strong fit for real-time/concurrent systems (Erlang/OTP).                             |
| **Swift**   | Lower    | iOS/macOS native. Mobile-first sync scenarios.                                                                   |
| **Kotlin**  | Lower    | Interops with Java, but separate client could provide better ergonomics.                                         |

---

## How to Contribute

### Creating a New Client

1. **Study the protocol**: Read [PROTOCOL.md](./PROTOCOL.md) thoroughly
2. **Reference existing clients**: The TypeScript client is the canonical reference
3. **Use conformance tests**: Run `pnpm test:run -- --client <language>` against your implementation
4. **Follow ecosystem conventions**: Look at how other streaming libraries (Kafka, NATS, Redis) structure their clients in your language

### Leveling Up an Existing Client

#### From Level 1 to Level 2:

If you're an expert in a language where we have a Level 1 client:

1. **Review the API**: Does it feel natural for the ecosystem? Compare to popular libraries.
2. **Check error handling**: Does it follow language conventions? (e.g., Go's `error` returns, Python's exceptions, Rust's `Result`)
3. **Review documentation**: Are examples idiomatic? Would a newcomer understand them?
4. **Performance audit**: Any obvious inefficiencies? Unnecessary allocations?
5. **Open a PR**: Document what you reviewed and any changes made

#### From Level 2 to Level 3:

This happens organically through adoption, but you can help by:

1. **Using the client**: Real-world usage finds edge cases
2. **Reporting issues**: Even small papercuts help improve quality
3. **Contributing fixes**: Bug fixes and improvements are always welcome
4. **Sharing your experience**: Blog posts, talks, or case studies help others adopt

---

## Expert Review Checklist

When reviewing a client for Level 2 certification:

### API Design

- [ ] Method names follow language conventions (e.g., `snake_case` for Python, `camelCase` for Java)
- [ ] Error handling is idiomatic (exceptions vs. error returns vs. Result types)
- [ ] Resource cleanup follows patterns (context managers, defer, RAII, etc.)
- [ ] Async patterns are correct for the ecosystem
- [ ] Configuration follows ecosystem norms (builders, options, config structs)

### Documentation

- [ ] README shows installation for common package managers
- [ ] Quick start example is copy-pasteable
- [ ] API documentation is complete
- [ ] Examples follow ecosystem conventions

### Implementation Quality

- [ ] No obvious performance issues
- [ ] Reasonable memory usage
- [ ] Proper HTTP connection handling
- [ ] Timeout and cancellation support
- [ ] Thread/concurrency safety documented

### Testing

- [ ] Passes conformance test suite
- [ ] Unit tests for language-specific code paths
- [ ] CI/CD pipeline for automated testing

---

## Versioning and Stability

All clients follow [semantic versioning](https://semver.org/):

- **Level 1 clients**: May have breaking changes in minor versions (0.x.y)
- **Level 2+ clients**: Follow semver strictly after 1.0.0

We recommend Level 1 clients pin exact versions and Level 2+ clients use compatible version ranges.

---

## Questions?

- Open an issue on [GitHub](https://github.com/durable-streams/durable-streams/issues)
- Check existing client implementations for patterns
- Ask in discussions for guidance on new client development
