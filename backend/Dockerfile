FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -i https://pypi.org/simple -r requirements.txt

COPY app ./app

RUN mkdir -p /data/uploads
VOLUME ["/data/uploads"]

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=10 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
