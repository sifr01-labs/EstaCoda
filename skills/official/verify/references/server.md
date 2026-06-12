# Server Verification Patterns

## Generic Steps

1. **Start the server**
   ```bash
   npm run dev
   # or
   python -m uvicorn main:app
   # or
   docker-compose up
   ```

2. **Wait for readiness**
   ```bash
   sleep 3 && curl -s http://localhost:3000/health
   ```

3. **Hit a smoke endpoint**
   ```bash
   curl -s http://localhost:3000/api/status | jq .
   ```

4. **Check logs for errors**
   ```bash
   # In another terminal or from the same session output
   grep -i error /tmp/server.log
   ```

5. **Stop cleanly**
   ```bash
   pkill -f "node.*dev" || true
   # or
   docker-compose down
   ```

## Common Pitfalls

- Port already in use from a previous run
- Missing environment variables (DATABASE_URL, API_KEY)
- Database migrations not run
- Build artifacts stale (need rebuild before start)
- Server takes longer than expected to start — increase wait time
