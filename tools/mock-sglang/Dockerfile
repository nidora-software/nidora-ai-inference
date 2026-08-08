# Stand-in for the SGLang Diffusion API — used by the GPU-free e2e harness.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn python-multipart
COPY server.py ./
COPY fixtures ./fixtures
ENV PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
