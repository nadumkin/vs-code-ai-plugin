FROM python:3.12-slim

WORKDIR /app

COPY proxy_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common ./common
COPY proxy_service ./proxy_service

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
EXPOSE 8000

CMD ["uvicorn", "proxy_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
