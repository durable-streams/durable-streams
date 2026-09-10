# Protocol Extensions

Extensions documented in this directory follow Section 11.1 of [the Durable Streams Protocol](../PROTOCOL.md): each is a pure superset of the base protocol — opt-in, additive, and invisible to base clients and to streams that do not use it. A server that implements none of them is still a fully conforming Durable Streams server.

| Extension     | Document                             | Summary                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write Fencing | [write-fencing.md](write-fencing.md) | Opt-in fenced streams bind the append data plane to the Section 7.3 subscription generation fence: writes ride a claim-scoped write token, the writer epoch is the claim generation, and completed or deposed claims are sealed so a zombie writer can never land another byte. |
