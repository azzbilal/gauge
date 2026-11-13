FROM python:3.12-slim

WORKDIR /app
COPY . verify/
ENV VERIFY_HOST=0.0.0.0
EXPOSE 4000
CMD ["python", "verify/service/main.py"]
