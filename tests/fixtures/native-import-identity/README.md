These three files are byte-exact saved observations from the approved local
storage-isolation fixture, not generated unit-test responses:

- `docker-inspect.json`: `storage-isolation-fixture/receipts/run-07/image-inspect.log`
- `manifest.json`: `storage-isolation-fixture/receipts/run-07/loaded-oci-manifest.log`
- `config.json`: `storage-isolation-fixture/receipts/run-07/loaded-config.log`

Original evidence root:
`/home/kai/task-evidence/coach-upgrade-reliability/`.
Docker/dockerd 29.1.3, containerd 2.2.1. The manifest and config were fetched by
the prior fixture through its explicitly pinned containerd socket. This task
did not contact Docker/containerd or repeat that runtime qualification.

The manifest hashes to
`sha256:6b4d68913401e581a18677a26989bdfdc5a189eca65e9e3603ef68ceeb0b126d`;
the config hashes to
`sha256:084e2d041325469f4a375a1d4c88ee47c96a9e285289307eca5955fd0686bdf6`.
The approved signed archive is 126313107 bytes, SHA-256
`8255e76c436bbbd9aba622598dc22ac5e9566d63ac020cb3bd69b7296777fec3`.

Tests replay inspection data through explicitly mocked boundaries, mutate
copies for hostile controls, and use separately labeled synthetic archives.
Neither those mocks nor the metadata alone establish the full archive hash;
the substantive task report separately records the read-only full-archive check.
