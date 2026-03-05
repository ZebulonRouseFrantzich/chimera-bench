export class ResponseBodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super(`Case response exceeded ${maxBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{
  text: string;
  byteLength: number;
}> {
  // Content-Length is only an optimization hint; authoritative enforcement is
  // the streaming byte accumulator below.
  const declaredContentLength = parseContentLengthHeader(response.headers.get("content-length"));
  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes, declaredContentLength);
  }

  if (!response.body) {
    return {
      text: "",
      byteLength: 0,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      observedBytes += value.byteLength;
      if (observedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stream cancellation; preserve the limit error.
        }
        throw new ResponseBodyTooLargeError(maxBytes, observedBytes);
      }

      chunks.push(value);
    }

    if (observedBytes === 0) {
      return {
        text: "",
        byteLength: 0,
      };
    }

    const buffer = new Uint8Array(observedBytes);
    let writeOffset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }

    return {
      text: new TextDecoder().decode(buffer),
      byteLength: observedBytes,
    };
  } finally {
    reader.releaseLock();
  }
}

function parseContentLengthHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}
