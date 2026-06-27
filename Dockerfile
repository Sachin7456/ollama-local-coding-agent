# Run qwen-harness CONTAINED — the durable answer to destructive commands.
#
# Inside a container the agent can only touch the workspace you mount, so even an UNKNOWN destructive
# command (rm -rf, a package manager, an interpreter escape) cannot harm your host — which a command
# allow/deny list can never fully guarantee. This is the recommended way to use acceptEdits / bypass.
#
#   docker build -t qwen-harness .
#   # mount ONLY your project as the writable workspace; reach Ollama running on the host:
#   docker run --rm -it \
#     -v "$PWD:/work" -w /work \
#     -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
#     --add-host host.docker.internal:host-gateway \
#     qwen-harness --mode acceptEdits "refactor the utils module"
#
# (macOS / Windows Docker Desktop already provide host.docker.internal; on Linux --add-host maps it.)
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV OLLAMA_BASE_URL=http://host.docker.internal:11434
ENTRYPOINT ["node", "--experimental-strip-types", "src/cli/main.ts"]
