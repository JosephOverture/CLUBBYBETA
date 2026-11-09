import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from '../platform/config';
import { ApiError } from '../platform/http';
import { createHash } from 'node:crypto';

export class ObjectStore {
  private readonly s3?: S3Client;
  constructor(
    readonly config: Config,
    private readonly root = resolve('.local-data/media'),
  ) {
    if (config.STORAGE_MODE === 's3')
      this.s3 = new S3Client({
        region: config.S3_REGION,
        maxAttempts: 3,
        requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 },
        credentials: config.S3_ACCESS_KEY_ID
          ? {
              accessKeyId: config.S3_ACCESS_KEY_ID!,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
              sessionToken: config.S3_SESSION_TOKEN,
            }
          : undefined,
      });
  }
  private validate(key: string) {
    if (!/^[a-f0-9-]{36}\/(original|thumbnail\.webp|hero\.webp)$/.test(key))
      throw new Error('Invalid storage key.');
    if (this.config.STORAGE_MODE === 'disabled')
      throw new ApiError('NOT_CONFIGURED', 'Media storage is not configured.', 503);
  }
  async put(key: string, data: Buffer, type: string) {
    this.validate(key);
    if (this.s3) {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.config.S3_BUCKET,
            Key: key,
            Body: data,
            ContentType: type,
            IfNoneMatch: '*',
            ServerSideEncryption: 'AES256',
          }),
        );
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          '$metadata' in error &&
          (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412
        ))
          throw error;
        if (
          createHash('sha256')
            .update(await this.get(key))
            .digest('hex') !== createHash('sha256').update(data).digest('hex')
        )
          throw new Error('Object conflict.');
      }
    } else {
      const path = resolve(this.root, key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        if (!(await readFile(path)).equals(data)) throw new Error('Object conflict.');
      }
    }
  }
  async get(key: string) {
    this.validate(key);
    if (this.s3) {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      if (!result.Body || (result.ContentLength ?? 0) > 5 * 1024 * 1024)
        throw new Error('Invalid object size.');
      return Buffer.from(await result.Body.transformToByteArray());
    }
    const path = resolve(this.root, key);
    if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error('Invalid object size.');
    return readFile(path);
  }
  async delete(key: string) {
    this.validate(key);
    if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
    else
      try {
        await unlink(resolve(this.root, key));
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
  }
}
