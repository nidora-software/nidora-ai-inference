# The pod agent on a plain Python base, with no CUDA and no SGLang.
#
# Only for the e2e harness (deploy/compose.e2e.yml): it lets the real agent run
# on a laptop or a CI runner against the mock SGLang server. Production pods get
# the agent from the GPU image (see the repo-root Dockerfile).
FROM python:3.12-slim
WORKDIR /app
COPY agent /app/agent
RUN pip install --no-cache-dir /app/agent
CMD ["python", "-m", "nidora_agent"]
