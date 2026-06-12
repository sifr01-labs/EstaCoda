# CLI Verification Patterns

## Generic Steps

1. **Build**
   ```bash
   npm run build
   # or
   cargo build --release
   # or
   go build ./...
   ```

2. **Run with typical args**
   ```bash
   node dist/cli.js --help
   # or
   ./my-cli status
   ```

3. **Run tests**
   ```bash
   npm test
   # or
   cargo test
   # or
   go test ./...
   ```

4. **Check exit code**
   ```bash
   echo $?
   ```

## Common Pitfalls

- Missing build step before running
- Running the wrong binary (source vs built)
- Environment variables not set
- Global CLI not updated after local changes
