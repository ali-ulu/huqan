# Third-party A2A receiver

This example is a separate consumer of a HUQAN signed exchange and imports no
HUQAN runtime code. The conformance suite generates a real signed exchange,
launches this receiver in a child process, and compares its canonical signing
bytes and hashes with the producer's values.

```sh
node examples/a2a-third-party-agent/receiver.js exchange.json
```

The input contains `request` and `authority`. Exit status `0` means the request
and delegation signatures are valid, `1` is a cryptographic refusal, and `2`
means malformed input or invocation.
