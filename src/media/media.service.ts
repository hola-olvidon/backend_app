import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';

@Injectable()
export class MediaService {
  private s3Client: S3Client;
  private bucketName: string;
  private endpoint: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.endpoint = process.env.AWS_S3_ENDPOINT || '';
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: this.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
    this.bucketName = process.env.AWS_S3_BUCKET_NAME || '';
  }

  async uploadAudio(
    file: {
      originalname: string;
      buffer: Buffer;
      mimetype: string;
    },
    nombre?: string,
  ): Promise<{ nombre: string; nombreArchivo: string; urlAudio: string }> {
    if (!file) {
      throw new BadRequestException('No se ha proporcionado ningún archivo');
    }

    // Generar un nombre único para evitar sobreescribir archivos (ej: 123e4567-audio.mp3)
    const fileExtension = file.originalname.split('.').pop();
    const fileKey = `${(uuidv4 as () => string)()}.${fileExtension}`;
    const fileName = `audios/${fileKey}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        originalfilename: encodeURIComponent(file.originalname),
      },
    });

    await this.s3Client.send(command);

    // Formato correcto para MinIO
    // Limpiamos la barra final del endpoint por si venía con "/"
    const cleanEndpoint = this.endpoint.replace(/\/$/, '');
    const urlAudio = `${cleanEndpoint}/${this.bucketName}/${fileName}`;

    // Guardamos el nombre editable en BD; por defecto se usa el nombre original del archivo.
    const audio = await this.prisma.audio.create({
      data: {
        nombre: nombre?.trim() ? nombre.trim() : file.originalname,
        nombreArchivo: fileKey,
        urlAudio,
      },
    });

    return {
      nombre: audio.nombre,
      nombreArchivo: audio.nombreArchivo,
      urlAudio: audio.urlAudio,
    };
  }

  async listAudios(): Promise<
    { nombre: string; nombreArchivo: string; urlAudio: string }[]
  > {
    const [response, dbAudios] = await Promise.all([
      this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: 'audios/',
        }),
      ),
      this.prisma.audio.findMany(),
    ]);

    if (!response.Contents) {
      return [];
    }

    const cleanEndpoint = this.endpoint.replace(/\/$/, '');
    const dbByName = new Map(dbAudios.map((audio) => [audio.nombreArchivo, audio]));

    const audiosPromesas = response.Contents.filter(
      (item) => item.Key && item.Key !== 'audios/',
    ).map(async (item) => {
      const nombreArchivo = item.Key!.replace('audios/', '');
      const urlAudio = `${cleanEndpoint}/${this.bucketName}/${item.Key}`;

      // Nombre editable guardado en BD (fuente de verdad).
      const dbRecord = dbByName.get(nombreArchivo);
      if (dbRecord) {
        return { nombre: dbRecord.nombre, nombreArchivo, urlAudio };
      }

      // Fallback para audios legacy sin registro en BD: nombre original desde metadata S3.
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: item.Key!,
      });
      const metadataResponse = await this.s3Client.send(headCommand);

      const rawName = metadataResponse.Metadata?.originalfilename;
      const nombre = rawName ? decodeURIComponent(rawName) : nombreArchivo;

      return { nombre, nombreArchivo, urlAudio };
    });

    return Promise.all(audiosPromesas);
  }

  async renameAudio(
    fileKey: string,
    nombre?: string,
  ): Promise<{ nombre: string; nombreArchivo: string; urlAudio: string }> {
    const cleanName = nombre?.trim();
    if (!cleanName) {
      throw new BadRequestException('El nombre del audio no puede estar vacío');
    }

    const cleanEndpoint = this.endpoint.replace(/\/$/, '');
    const urlAudio = `${cleanEndpoint}/${this.bucketName}/audios/${fileKey}`;

    // Upsert: renombra el registro existente o lo crea si es un audio legacy sin BD.
    const existing = await this.prisma.audio.findUnique({
      where: { nombreArchivo: fileKey },
    });

    const audio = existing
      ? await this.prisma.audio.update({
          where: { id: existing.id },
          data: { nombre: cleanName },
        })
      : await this.prisma.audio.create({
          data: { nombre: cleanName, nombreArchivo: fileKey, urlAudio },
        });

    return {
      nombre: audio.nombre,
      nombreArchivo: audio.nombreArchivo,
      urlAudio: audio.urlAudio,
    };
  }

  async streamAudio(fileKey: string): Promise<{
    body: Readable;
    contentType?: string;
  }> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: `audios/${fileKey}`,
        }),
      );

      return {
        body: response.Body as Readable,
        contentType: response.ContentType,
      };
    } catch (err: unknown) {
      const e = err as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
        throw new NotFoundException(`Audio "${fileKey}" no encontrado`);
      }
      throw err;
    }
  }

  async deleteAudio(
    fileKey: string,
  ): Promise<{ message: string; alarmasActualizadas: number }> {
    // 1. Armar la URL exacta guardada en BD para buscar coincidencias
    const cleanEndpoint = this.endpoint.replace(/\/$/, '');
    const fullUrl = `${cleanEndpoint}/${this.bucketName}/audios/${fileKey}`;

    // 2. Borrar el objeto en MinIO / S3
    const deleteCommand = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: `audios/${fileKey}`,
    });

    await this.s3Client.send(deleteCommand);

    // 3. Actualizar en PostgreSQL/Prisma todas las alarmas que usaban esta URL
    const updateResult = await this.prisma.alarm.updateMany({
      where: {
        urlAudio: fullUrl,
      },
      data: {
        urlAudio: null, // O cambiar por una URL por defecto
      },
    });

    // 4. Borrar el registro de audio (nombre editable) de la BD
    await this.prisma.audio.deleteMany({
      where: { nombreArchivo: fileKey },
    });

    return {
      message: `Archivo audios/${fileKey} eliminado correctamente`,
      alarmasActualizadas: updateResult.count,
    };
  }
}
