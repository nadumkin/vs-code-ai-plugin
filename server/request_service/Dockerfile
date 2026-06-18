FROM python:3.12-slim

WORKDIR /app

COPY request_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY request_service ./request_service

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
EXPOSE 8081

CMD ["uvicorn", "request_service.main:app", "--host", "0.0.0.0", "--port", "8081"]
