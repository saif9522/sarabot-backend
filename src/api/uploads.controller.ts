import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { randomBytes } from 'crypto';
import { ALLOWED_MIME } from '../media';
import { saveMedia } from '../media-store';
import { PrismaService } from '../prisma.service';
import { Roles } from '../auth/auth.guard';

const MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for images is 5 MB and documents 100 MB; keep uploads modest.

/** Images and documents for flow steps. Files are served at /uploads/<name>. */
@Roles('owner', 'admin')
@Controller('uploads')
export class UploadsController {
  constructor(private prisma: PrismaService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BYTES } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file received');
    const type = ALLOWED_MIME[file.mimetype];
    if (!type) throw new BadRequestException('Use a JPG, PNG or WebP image, or a PDF, Word or Excel file');
    if (type.kind === 'image' && file.size > 5 * 1024 * 1024) throw new BadRequestException('Images must be under 5 MB for WhatsApp');
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}${type.ext}`;
    await saveMedia(this.prisma, name, file.mimetype, file.buffer); // database = permanent, disk = cache
    return { media: name, kind: type.kind, fileName: file.originalname.slice(0, 200), size: file.size };
  }
}
