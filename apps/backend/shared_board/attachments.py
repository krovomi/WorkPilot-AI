"""Images a person attaches to a server card, or to a request for changes.

On the desktop the New Task dialog saves its images in the card's
``attachments/`` folder, and the review panel saves its own in the build
workspace's ``feedback_images/``; the agents read them from there. A server
card refused both: the app could not write into the server's clone. The app
now sends them in the request, and this module checks and stores them where
the same agents look.

An image is a person's file: kept only if its bytes are one of the raster
formats it claims to be (SVG, which can carry script, is not accepted), under
a size cap, with a name reduced to a safe base name, in a folder that is not a
link out of the clone.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

MAX_IMAGES = 10
MAX_IMAGE_BYTES = 5_000_000
#: Base64 of MAX_IMAGE_BYTES, rounded up: the field is refused before decoding.
MAX_IMAGE_B64 = (MAX_IMAGE_BYTES + 2) // 3 * 4
MAX_FILENAME = 120

Mime = Literal["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]

_MAGIC: dict[str, tuple[bytes, ...]] = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/jpg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
}
_UNSAFE = re.compile(r"[^A-Za-z0-9._ -]+")


class ImageUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mimeType: Mime
    data: str = Field(min_length=1, max_length=MAX_IMAGE_B64)


@dataclass(frozen=True)
class Image:
    filename: str
    mime: str
    content: bytes


def _is(mime: str, content: bytes) -> bool:
    if mime == "image/webp":
        return content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    return any(content.startswith(sig) for sig in _MAGIC[mime])


def _safe_name(raw: str) -> str:
    name = _UNSAFE.sub("_", Path(raw.replace("\\", "/")).name).strip(" .")
    return name[-MAX_FILENAME:] or "image"


def decode_images(uploads: list[ImageUpload]) -> list[Image]:
    """The images, checked; 422 for the first that is not what it says."""
    if len(uploads) > MAX_IMAGES:
        raise HTTPException(status_code=422, detail=f"At most {MAX_IMAGES} images")
    images: list[Image] = []
    for upload in uploads:
        try:
            content = base64.b64decode(upload.data, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(status_code=422, detail="An image is not base64") from e
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=422, detail="An image is too large")
        if not _is(upload.mimeType, content):
            raise HTTPException(
                status_code=422, detail="An image is not the type it claims"
            )
        images.append(Image(_safe_name(upload.filename), upload.mimeType, content))
    return images


def store_images(directory: Path, images: list[Image]) -> list[dict]:
    """Write the images into ``directory`` (created) and say what was written.

    Names are made unique within the folder; an existing file is never
    overwritten, and a folder that is a link is refused.
    """
    if not images:
        return []
    if directory.is_symlink():
        raise HTTPException(status_code=409, detail="The attachments folder is a link")
    directory.mkdir(parents=True, exist_ok=True)
    stored: list[dict] = []
    for image in images:
        stem, dot, ext = image.filename.rpartition(".")
        name = image.filename
        n = 1
        while (directory / name).exists() or (directory / name).is_symlink():
            n += 1
            name = f"{stem}-{n}.{ext}" if dot else f"{image.filename}-{n}"
        with open(directory / name, "xb") as handle:
            handle.write(image.content)
        stored.append(
            {
                "id": str(uuid.uuid4()),
                "filename": name,
                "mimeType": image.mime,
                "size": len(image.content),
                "path": f"{directory.name}/{name}",
            }
        )
    return stored
