import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles, ws } from '../auth/auth.guard';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUrl, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';

class CategoryDto { @IsString() @MinLength(1) @MaxLength(80) name!: string }
class ProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() categoryId?: string | null;
  @IsOptional() @IsString() @MaxLength(80) sku?: string | null;
  @IsOptional() @IsNumber() @Min(0) price?: number | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsBoolean() inStock?: boolean;
  @IsOptional() @IsUrl() imageUrl?: string | null;
}

@Controller()
export class ProductsController {
  constructor(private prisma: PrismaService) {}

  private async ownCategory(u: AuthUser, id?: string | null) {
    if (id && !(await this.prisma.productCategory.findFirst({ where: { id, workspaceId: ws(u) } }))) throw new NotFoundException('Category not found');
  }
  private async ownProduct(u: AuthUser, id: string) {
    if (!(await this.prisma.product.findFirst({ where: { id, workspaceId: ws(u) } }))) throw new NotFoundException();
  }

  @Get('categories')
  categories(@CurrentUser() u: AuthUser) {
    return this.prisma.productCategory.findMany({ where: { workspaceId: ws(u) }, orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
  }
  @Roles('owner', 'admin')
  @Post('categories')
  addCategory(@CurrentUser() u: AuthUser, @Body() dto: CategoryDto) {
    return this.prisma.productCategory.create({ data: { workspaceId: ws(u), name: dto.name.trim() } });
  }
  @Roles('owner', 'admin')
  @Delete('categories/:id')
  async removeCategory(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.ownCategory(u, id);
    return this.prisma.productCategory.delete({ where: { id } });
  }

  @Get('products')
  products(@CurrentUser() u: AuthUser, @Query('q') q?: string, @Query('categoryId') categoryId?: string) {
    return this.prisma.product.findMany({
      where: {
        workspaceId: ws(u),
        ...(categoryId ? { categoryId } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      include: { category: { select: { id: true, name: true } } },
    });
  }
  @Roles('owner', 'admin')
  @Post('products')
  async addProduct(@CurrentUser() u: AuthUser, @Body() dto: ProductDto) {
    await this.ownCategory(u, dto.categoryId);
    return this.prisma.product.create({ data: { ...dto, workspaceId: ws(u), name: dto.name || 'Untitled product', categoryId: dto.categoryId || null } });
  }
  @Roles('owner', 'admin')
  @Patch('products/:id')
  async updateProduct(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProductDto) {
    await this.ownProduct(u, id);
    await this.ownCategory(u, dto.categoryId);
    return this.prisma.product.update({ where: { id }, data: { ...dto, ...(dto.categoryId === '' ? { categoryId: null } : {}) } });
  }
  @Roles('owner', 'admin')
  @Delete('products/:id')
  async removeProduct(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.ownProduct(u, id);
    return this.prisma.product.delete({ where: { id } });
  }
}
