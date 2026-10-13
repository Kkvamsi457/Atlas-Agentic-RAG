
from pathlib import Path
import re
import hashlib

import pymupdf
import chromadb
from sentence_transformers import SentenceTransformer

from .config import (
    DATA_DIR,
    CHROMA_DIR,
    COLLECTION_NAME,
    EMBEDDING_MODEL,
    CHUNK_SIZE,
    CHUNK_OVERLAP,
)


def clean_text(text: str) -> str:
    """Clean extracted PDF text."""
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_text(
    text: str,
    size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Split text into word-based chunks with overlap."""
    if size <= 0:
        raise ValueError("CHUNK_SIZE must be greater than zero.")

    if overlap < 0 or overlap >= size:
        raise ValueError(
            "CHUNK_OVERLAP must be non-negative and smaller than CHUNK_SIZE."
        )

    words = text.split()

    if not words:
        return []

    chunks = []
    start = 0

    while start < len(words):
        end = min(start + size, len(words))
        chunks.append(" ".join(words[start:end]))

        if end >= len(words):
            break

        start = end - overlap

    return chunks


def extract_pdf(pdf_path: Path) -> list[dict]:
    """Extract text from a PDF and create chunk records."""
    records = []

    # Use pymupdf consistently; no fitz import is required.
    with pymupdf.open(pdf_path) as doc:
        for page_num, page in enumerate(doc, start=1):
            text = clean_text(page.get_text("text"))

            if not text:
                continue

            for chunk_index, chunk in enumerate(split_text(text)):
                records.append(
                    {
                        "text": chunk,
                        "source_doc": pdf_path.name,
                        "page_number": page_num,
                        "section_heading": None,
                        "chunk_index": chunk_index,
                    }
                )

    return records


def get_collection():
    """Get or create the persistent ChromaDB collection."""
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))

    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def ingest(force: bool = False) -> int:
    """Extract PDF files, generate embeddings, and index chunks.

    Args:
        force: If True, delete and rebuild the existing collection.

    Returns:
        Total number of chunks indexed.
    """
    pdfs = sorted(DATA_DIR.glob("*.pdf"))

    if not pdfs:
        raise FileNotFoundError(
            f"No PDF files found in {DATA_DIR}"
        )

    model = SentenceTransformer(EMBEDDING_MODEL)

    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    if force and collection.count() > 0:
        client.delete_collection(name=COLLECTION_NAME)

        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )

        print("Existing collection deleted. Rebuilding the index...")

    total = 0

    for pdf in pdfs:
        print(f"Processing: {pdf.name}")

        records = extract_pdf(pdf)

        if not records:
            print(f"WARNING: No extractable text in {pdf.name}")
            continue

        texts = [record["text"] for record in records]

        embeddings = model.encode(
            texts,
            normalize_embeddings=True,
        ).tolist()

        ids = []
        metadatas = []

        for record in records:
            raw = (
                f'{record["source_doc"]}|'
                f'{record["page_number"]}|'
                f'{record["chunk_index"]}|'
                f'{record["text"][:80]}'
            )

            chunk_id = hashlib.sha1(
                raw.encode("utf-8")
            ).hexdigest()

            ids.append(chunk_id)

            metadatas.append(
                {
                    "source_doc": record["source_doc"],
                    "page_number": record["page_number"],
                    "section_heading": record["section_heading"] or "",
                    "chunk_index": record["chunk_index"],
                }
            )

        collection.upsert(
            ids=ids,
            documents=texts,
            metadatas=metadatas,
            embeddings=embeddings,
        )

        total += len(records)

        print(f"Ingested {pdf.name}: {len(records)} chunks")

    print(f"Total chunks indexed: {total}")

    return total


if __name__ == "__main__":
    ingest(force=True)
