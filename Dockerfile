FROM python:3.12-alpine

WORKDIR /app

# tzdata: timezone resolution for log timestamps.
# ffmpeg: video frames + audio waveform spectrograms (alpine builds with
#         --enable-libopenmpt so tracker modules .mod/.it/.s3m/.xm/etc.
#         render to spectrograms natively).
#
# pip install (musllinux wheels): Pillow encodes JPEG/WEBP thumbs;
# mutagen extracts embedded cover-art and audio metadata. We use pip
# (not apk's py3-* packages) because alpine's system-python and
# python:3.12-alpine's /usr/local/bin/python don't share site-packages.
RUN apk add --no-cache tzdata ffmpeg \
 && pip install --no-cache-dir jinja2 Pillow mutagen

COPY kopyparty/ /app/kopyparty/

EXPOSE 3923

ENTRYPOINT ["python", "-m", "kopyparty"]
CMD ["--no-crt", "-i", "0.0.0.0", "-p", "3923", "-v", "/data::r"]
