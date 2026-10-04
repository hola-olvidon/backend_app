-- CreateTable
CREATE TABLE "Audio" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nombreArchivo" TEXT NOT NULL,
    "urlAudio" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Audio_nombreArchivo_key" ON "Audio"("nombreArchivo");

-- CreateIndex
CREATE UNIQUE INDEX "Audio_urlAudio_key" ON "Audio"("urlAudio");
