FROM python:3.12-slim

WORKDIR /app

# Set to "true" to also install the heavy HF/torch stack for the hf_local adapter.
ARG INSTALL_HF=false

COPY llm_service/requirements.txt ./requirements.txt
COPY llm_service/requirements-hf.txt ./requirements-hf.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    if [ "$INSTALL_HF" = "true" ]; then pip install --no-cache-dir -r requirements-hf.txt; fi

COPY common ./common
COPY llm_service ./llm_service

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
EXPOSE 8002

CMD ["uvicorn", "llm_service.main:app", "--host", "0.0.0.0", "--port", "8002"]
