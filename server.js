require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// 1. Cấu hình kết nối MySQL Pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, // ecommerce_product_db
    waitForConnections: true,
    connectionLimit: 10
});

// 2. Cấu hình Cognito JWT Verifier
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: "access",
    clientId: process.env.COGNITO_APP_CLIENT_ID
});

// 3. Cấu hình S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION
});

// 4. Helper tạo CloudFront URL từ image_key
function buildImageUrl(imageKey) {
    if (!imageKey) return null;

    const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;

    if (!cloudFrontDomain) {
        return null;
    }

    const cleanDomain = cloudFrontDomain
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

    const cleanKey = imageKey.replace(/^\//, '');

    return `https://${cleanDomain}/${cleanKey}`;
}

// 5. Helper lấy extension an toàn từ contentType
function getExtensionFromContentType(contentType) {
    const map = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif"
    };

    return map[contentType] || null;
}
// Helper xóa ảnh cũ khỏi S3
async function deleteImageFromS3(imageKey) {
    if (!imageKey) return;

    try {
        const command = new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: imageKey
        });

        await s3.send(command);
    } catch (error) {
        console.error("Lỗi xóa ảnh khỏi S3:", error);
    }
}

function isValidImageKey(imageKey) {
    return !imageKey || (
        typeof imageKey === "string" &&
        imageKey.startsWith("products/")
    );
}

function normalizeSubImageKeys(subImageKeys) {
    if (subImageKeys === undefined || subImageKeys === null) {
        return [];
    }

    if (!Array.isArray(subImageKeys)) {
        throw new Error("subImageKeys phải là một mảng!");
    }

    const cleanKeys = [];

    for (const key of subImageKeys) {
        if (!key) continue;

        if (!isValidImageKey(key)) {
            throw new Error("subImageKeys chứa imageKey không hợp lệ!");
        }

        if (!cleanKeys.includes(key)) {
            cleanKeys.push(key);
        }
    }

    return cleanKeys;
}

function normalizeVariants(variants) {
    if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error("Vui lòng nhập ít nhất một biến thể sản phẩm!");
    }

    const normalized = [];
    const duplicateMap = new Set();

    for (const variant of variants) {
        const sizeId = Number(variant.sizeId);
        const colorId = Number(variant.colorId);
        const stockQuantity = Number(variant.stockQuantity);
        const soldQuantity =
            variant.soldQuantity !== undefined && variant.soldQuantity !== null
                ? Number(variant.soldQuantity)
                : 0;

        if (!Number.isInteger(sizeId) || sizeId <= 0) {
            throw new Error("sizeId của biến thể không hợp lệ!");
        }

        if (!Number.isInteger(colorId) || colorId <= 0) {
            throw new Error("colorId của biến thể không hợp lệ!");
        }

        if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
            throw new Error("stockQuantity của biến thể không hợp lệ!");
        }

        if (!Number.isInteger(soldQuantity) || soldQuantity < 0) {
            throw new Error("soldQuantity của biến thể không hợp lệ!");
        }

        const duplicateKey = `${sizeId}:${colorId}`;

        if (duplicateMap.has(duplicateKey)) {
            throw new Error("Không được tạo trùng biến thể cùng size và màu!");
        }

        duplicateMap.add(duplicateKey);

        normalized.push({
            sizeId,
            colorId,
            stockQuantity,
            soldQuantity
        });
    }

    return normalized;
}

function parseOptionalDisplayOrder(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue < 0) {
        return null;
    }

    return numberValue;
}

function normalizeColorCode(value) {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || String(value).trim() === "") {
        return null;
    }

    const colorCode = String(value).trim();

    if (!/^#[0-9A-Fa-f]{6}$/.test(colorCode)) {
        throw new Error("Mã màu phải có dạng #RRGGBB, ví dụ #FF0000.");
    }

    return colorCode;
}

async function getProductDetail(productId) {
    const [productRows] = await dbPool.execute(
        `
        SELECT
            p.product_id,
            p.product_name,
            p.description,
            p.category_id,
            p.price,
            COALESCE(totals.total_stock_quantity, 0) AS stock_quantity,
            COALESCE(totals.total_sold_quantity, 0) AS sold_quantity,
            p.image_key,
            p.created_at,
            p.updated_at,
            c.category_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN (
            SELECT
                product_id,
                COALESCE(SUM(stock_quantity), 0) AS total_stock_quantity,
                COALESCE(SUM(sold_quantity), 0) AS total_sold_quantity
            FROM product_variants
            WHERE is_active = 1
            GROUP BY product_id
        ) totals ON totals.product_id = p.product_id
        WHERE p.product_id = ?
        `,
        [productId]
    );

    if (productRows.length === 0) {
        return null;
    }

    const product = productRows[0];

    const [imageRows] = await dbPool.execute(
        `
        SELECT
            image_id,
            product_id,
            image_key,
            sort_order,
            created_at
        FROM product_images
        WHERE product_id = ?
        ORDER BY sort_order ASC, image_id ASC
        `,
        [productId]
    );

    const [variantRows] = await dbPool.execute(
        `
        SELECT
            pv.variant_id,
            pv.product_id,
            pv.size_id,
            s.size_name,
            pv.color_id,
            c.color_name,
            c.color_code,
            pv.stock_quantity,
            pv.sold_quantity,
            pv.is_active,
            pv.created_at,
            pv.updated_at
        FROM product_variants pv
        JOIN sizes s ON pv.size_id = s.size_id
        JOIN colors c ON pv.color_id = c.color_id
        WHERE pv.product_id = ?
          AND pv.is_active = 1
        ORDER BY s.display_order ASC, c.display_order ASC, pv.variant_id ASC
        `,
        [productId]
    );

    return {
        ...product,
        imageUrl: buildImageUrl(product.image_key),
        images: imageRows.map(image => ({
            ...image,
            imageUrl: buildImageUrl(image.image_key)
        })),
        variants: variantRows
    };
}

// 6. MIDDLEWARE XÁC THỰC
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: "Không tìm thấy Token. Vui lòng đăng nhập!"
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const payload = await verifier.verify(token);

        req.user = {
            sub: payload.sub,
            username: payload.username || payload["cognito:username"] || payload.sub,
            groups: payload["cognito:groups"] || [],
            accessToken: token
        };

        next();
    } catch (error) {
        console.error("Lỗi verify token tại Product Service:", error);
        return res.status(401).json({
            error: "Token không hợp lệ hoặc đã hết hạn!"
        });
    }
}

// 7. MIDDLEWARE KIỂM TRA QUYỀN ADMIN
function adminMiddleware(req, res, next) {
    const groups = req.user.groups || [];

    if (!groups.includes("Admin")) {
        return res.status(403).json({
            error: "Quyền truy cập bị từ chối! Bạn không phải Admin."
        });
    }

    next();
}

// =========================================================================
// ROUTE MỞ: LẤY DANH SÁCH SẢN PHẨM
// =========================================================================
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await dbPool.execute(`
            SELECT 
                p.product_id,
                p.product_name,
                p.category_id,  
                p.description,
                p.price,
                COALESCE(totals.total_stock_quantity, 0) AS stock_quantity,
                COALESCE(totals.total_sold_quantity, 0) AS sold_quantity,
                p.image_key,
                p.created_at,
                p.updated_at,
                c.category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.category_id
            LEFT JOIN (
                SELECT
                    product_id,
                    COALESCE(SUM(stock_quantity), 0) AS total_stock_quantity,
                    COALESCE(SUM(sold_quantity), 0) AS total_sold_quantity
                FROM product_variants
                WHERE is_active = 1
                GROUP BY product_id
            ) totals ON totals.product_id = p.product_id
            ORDER BY p.created_at DESC
        `);

        const products = rows.map(product => ({
            ...product,
            imageUrl: buildImageUrl(product.image_key)
        }));

        return res.json({
            message: "Lấy danh sách sản phẩm thành công!",
            products
        });

    } catch (error) {
        console.error("Lỗi lấy danh sách sản phẩm:", error);
        return res.status(500).json({
            error: "Lỗi hệ thống không lấy được sản phẩm!"
        });
    }
});
// =========================================================================
// ROUTE MỞ: LẤY DANH SÁCH SIZE VÀ COLOR
// =========================================================================
app.get('/api/sizes', async (req, res) => {
    try {
        const [rows] = await dbPool.execute(
            `
            SELECT
                size_id,
                size_name,
                display_order,
                created_at
            FROM sizes
            ORDER BY display_order ASC, size_id ASC
            `
        );

        return res.json({
            message: "Lấy danh sách size thành công!",
            sizes: rows
        });

    } catch (error) {
        console.error("Lỗi lấy danh sách sizes:", error);
        return res.status(500).json({
            error: "Không thể lấy danh sách size!"
        });
    }
});

app.get('/api/colors', async (req, res) => {
    try {
        const [rows] = await dbPool.execute(
            `
            SELECT
                color_id,
                color_name,
                color_code,
                display_order,
                created_at
            FROM colors
            ORDER BY display_order ASC, color_id ASC
            `
        );

        return res.json({
            message: "Lấy danh sách màu thành công!",
            colors: rows
        });

    } catch (error) {
        console.error("Lỗi lấy danh sách colors:", error);
        return res.status(500).json({
            error: "Không thể lấy danh sách màu!"
        });
    }
});

// =========================================================================
// ROUTE MỞ: LẤY DANH SÁCH DANH MỤC
// =========================================================================
app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await dbPool.execute(
            `
            SELECT
                category_id,
                category_name,
                created_at
            FROM categories
            ORDER BY created_at DESC
            `
        );

        return res.json({
            message: "Lấy danh sách danh mục thành công!",
            categories: rows
        });

    } catch (error) {
        console.error("Lỗi lấy danh sách categories:", error);
        return res.status(500).json({
            error: "Không thể lấy danh sách danh mục!"
        });
    }
});
// =========================================================================
// ROUTE MỞ: LẤY CHI TIẾT SẢN PHẨM
// =========================================================================
app.get('/api/products/:productId', async (req, res) => {
    const { productId } = req.params;

    try {
        const product = await getProductDetail(productId);

        if (!product) {
            return res.status(404).json({
                error: "Không tìm thấy sản phẩm!"
            });
        }

        return res.json({
            message: "Lấy chi tiết sản phẩm thành công!",
            product
        });

    } catch (error) {
        console.error("Lỗi lấy chi tiết sản phẩm:", error);
        return res.status(500).json({
            error: "Không thể lấy chi tiết sản phẩm!"
        });
    }
});
// =========================================================================
// ROUTE BẢO MẬT: ADMIN XIN PRE-SIGNED URL ĐỂ UPLOAD ẢNH LÊN S3
// =========================================================================
app.post('/api/products/upload-url', authMiddleware, adminMiddleware, async (req, res) => {
    const { fileName, contentType } = req.body || {};

    if (!fileName || !contentType) {
        return res.status(400).json({
            error: "Vui lòng gửi fileName và contentType!"
        });
    }

    const extension = getExtensionFromContentType(contentType);

    if (!extension) {
        return res.status(400).json({
            error: "Chỉ chấp nhận ảnh định dạng jpeg, png, webp hoặc gif!"
        });
    }

    try {
        const imageKey = `products/${crypto.randomUUID()}.${extension}`;

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: imageKey,
            ContentType: contentType
        });

        const uploadUrl = await getSignedUrl(s3, command, {
            expiresIn: 300 // 5 phút
        });

        return res.json({
            message: "Tạo upload URL thành công!",
            uploadUrl,
            imageKey,
            imageUrl: buildImageUrl(imageKey)
        });

    } catch (error) {
        console.error("Lỗi tạo upload URL:", error);
        return res.status(500).json({
            error: "Không thể tạo upload URL!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC TẠO SẢN PHẨM
// =========================================================================
app.post('/api/products', authMiddleware, adminMiddleware, async (req, res) => {
    const {
        productName,
        description,
        categoryId,
        price,
        imageKey,
        subImageKeys,
        variants
    } = req.body || {};

    let cleanSubImageKeys;
    let cleanVariants;

    if (!productName || !productName.trim() || price === undefined) {
        return res.status(400).json({
            error: "Vui lòng nhập đầy đủ tên sản phẩm và giá tiền!"
        });
    }

    const nextPrice = Number(price);

    if (Number.isNaN(nextPrice) || nextPrice <= 0) {
        return res.status(400).json({
            error: "Giá sản phẩm phải lớn hơn 0!"
        });
    }

    if (!isValidImageKey(imageKey)) {
        return res.status(400).json({
            error: "imageKey không hợp lệ!"
        });
    }

    try {
        cleanSubImageKeys = normalizeSubImageKeys(subImageKeys);
        cleanVariants = normalizeVariants(variants);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `
            INSERT INTO products (
                product_name,
                description,
                category_id,
                price,
                image_key
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
                productName.trim(),
                description ? description.trim() : null,
                categoryId || null,
                nextPrice,
                imageKey || null
            ]
        );

        const productId = result.insertId;

        for (let index = 0; index < cleanSubImageKeys.length; index += 1) {
            await connection.execute(
                `
                INSERT INTO product_images (
                    product_id,
                    image_key,
                    sort_order
                )
                VALUES (?, ?, ?)
                `,
                [productId, cleanSubImageKeys[index], index + 1]
            );
        }

        for (const variant of cleanVariants) {
            await connection.execute(
                `
                INSERT INTO product_variants (
                    product_id,
                    size_id,
                    color_id,
                    stock_quantity,
                    sold_quantity,
                    is_active
                )
                VALUES (?, ?, ?, ?, ?, 1)
                `,
                [
                    productId,
                    variant.sizeId,
                    variant.colorId,
                    variant.stockQuantity,
                    variant.soldQuantity
                ]
            );
        }

        await connection.commit();

        const product = await getProductDetail(productId);

        return res.status(201).json({
            message: "Admin đã tạo sản phẩm mới thành công!",
            product
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        console.error("Lỗi tạo sản phẩm:", error);

        if (error.code === "ER_NO_REFERENCED_ROW_2") {
            return res.status(400).json({
                error: "categoryId, sizeId hoặc colorId không tồn tại!"
            });
        }

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Có biến thể bị trùng size và màu!"
            });
        }

        return res.status(500).json({
            error: "Không thể tạo sản phẩm, lỗi hệ thống!"
        });

    } finally {
        if (connection) connection.release();
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC SỬA SẢN PHẨM
// =========================================================================
app.put('/api/products/:productId', authMiddleware, adminMiddleware, async (req, res) => {
    const { productId } = req.params;

    const {
        productName,
        description,
        categoryId,
        price,
        imageKey,
        subImageKeys,
        variants
    } = req.body || {};

    let cleanSubImageKeys;
    let cleanVariants;

    if (subImageKeys !== undefined) {
        try {
            cleanSubImageKeys = normalizeSubImageKeys(subImageKeys);
        } catch (error) {
            return res.status(400).json({
                error: error.message
            });
        }
    }

    if (variants !== undefined) {
        try {
            cleanVariants = normalizeVariants(variants);
        } catch (error) {
            return res.status(400).json({
                error: error.message
            });
        }
    }

    let connection;
    let oldMainImageKey = null;
    let oldSubImageKeys = [];

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `
            SELECT
                product_id,
                product_name,
                description,
                category_id,
                price,
                image_key
            FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                error: "Không tìm thấy sản phẩm cần sửa!"
            });
        }

        const currentProduct = rows[0];
        oldMainImageKey = currentProduct.image_key;

        const nextProductName =
            productName !== undefined ? productName.trim() : currentProduct.product_name;

        const nextDescription =
            description !== undefined
                ? (description ? description.trim() : null)
                : currentProduct.description;

        const nextCategoryId =
            categoryId !== undefined
                ? (
                    categoryId !== null && categoryId !== ""
                        ? Number(categoryId)
                        : null
                )
                : currentProduct.category_id;

        const nextPrice =
            price !== undefined ? Number(price) : Number(currentProduct.price);

        const nextImageKey =
            imageKey !== undefined ? imageKey : currentProduct.image_key;

        if (!nextProductName) {
            await connection.rollback();

            return res.status(400).json({
                error: "Tên sản phẩm không được để trống!"
            });
        }

        if (Number.isNaN(nextPrice) || nextPrice <= 0) {
            await connection.rollback();

            return res.status(400).json({
                error: "Giá sản phẩm phải lớn hơn 0!"
            });
        }

        if (!isValidImageKey(nextImageKey)) {
            await connection.rollback();

            return res.status(400).json({
                error: "imageKey không hợp lệ!"
            });
        }

        await connection.execute(
            `
            UPDATE products
            SET
                product_name = ?,
                description = ?,
                category_id = ?,
                price = ?,
                image_key = ?
            WHERE product_id = ?
            `,
            [
                nextProductName,
                nextDescription || null,
                nextCategoryId,
                nextPrice,
                nextImageKey || null,
                productId
            ]
        );

        // Nếu FE gửi subImageKeys thì cập nhật lại toàn bộ ảnh phụ
        // Nếu không gửi subImageKeys thì giữ nguyên ảnh phụ cũ
        if (cleanSubImageKeys !== undefined) {
            const [oldImageRows] = await connection.execute(
                `
                SELECT image_key
                FROM product_images
                WHERE product_id = ?
                `,
                [productId]
            );

            oldSubImageKeys = oldImageRows.map(row => row.image_key);

            await connection.execute(
                `
                DELETE FROM product_images
                WHERE product_id = ?
                `,
                [productId]
            );

            for (let index = 0; index < cleanSubImageKeys.length; index += 1) {
                await connection.execute(
                    `
                    INSERT INTO product_images (
                        product_id,
                        image_key,
                        sort_order
                    )
                    VALUES (?, ?, ?)
                    `,
                    [productId, cleanSubImageKeys[index], index + 1]
                );
            }
        }

        // Nếu FE gửi variants thì cập nhật lại danh sách biến thể
        // Variant cũ không còn dùng nữa sẽ chuyển is_active = 0
        if (cleanVariants !== undefined) {
            const [oldVariantRows] = await connection.execute(
                `
                SELECT
                    size_id,
                    color_id,
                    sold_quantity
                FROM product_variants
                WHERE product_id = ?
                `,
                [productId]
            );

            const oldSoldQuantityMap = new Map();

            for (const oldVariant of oldVariantRows) {
                oldSoldQuantityMap.set(
                    `${oldVariant.size_id}:${oldVariant.color_id}`,
                    Number(oldVariant.sold_quantity) || 0
                );
            }

            await connection.execute(
                `
                UPDATE product_variants
                SET is_active = 0
                WHERE product_id = ?
                `,
                [productId]
            );

            for (const variant of cleanVariants) {
                const variantKey = `${variant.sizeId}:${variant.colorId}`;

                const preservedSoldQuantity =
                    oldSoldQuantityMap.has(variantKey)
                        ? oldSoldQuantityMap.get(variantKey)
                        : variant.soldQuantity;

                await connection.execute(
                    `
                    INSERT INTO product_variants (
                        product_id,
                        size_id,
                        color_id,
                        stock_quantity,
                        sold_quantity,
                        is_active
                    )
                    VALUES (?, ?, ?, ?, ?, 1)
                    ON DUPLICATE KEY UPDATE
                        stock_quantity = VALUES(stock_quantity),
                        sold_quantity = VALUES(sold_quantity),
                        is_active = 1
                    `,
                    [
                        productId,
                        variant.sizeId,
                        variant.colorId,
                        variant.stockQuantity,
                        preservedSoldQuantity
                    ]
                );
            }
        }

        await connection.commit();

        // Xóa ảnh chính cũ khỏi S3 nếu admin đổi sang ảnh chính mới
        if (
            oldMainImageKey &&
            nextImageKey &&
            oldMainImageKey !== nextImageKey
        ) {
            await deleteImageFromS3(oldMainImageKey);
        }

        // Xóa ảnh phụ cũ khỏi S3 nếu không còn nằm trong danh sách ảnh phụ mới
        if (cleanSubImageKeys !== undefined) {
            const removedSubImageKeys = oldSubImageKeys.filter(
                oldKey => !cleanSubImageKeys.includes(oldKey)
            );

            for (const removedKey of removedSubImageKeys) {
                await deleteImageFromS3(removedKey);
            }
        }

        const product = await getProductDetail(productId);

        return res.json({
            message: "Admin đã cập nhật sản phẩm thành công!",
            product
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        console.error("Lỗi sửa sản phẩm:", error);

        if (error.code === "ER_NO_REFERENCED_ROW_2") {
            return res.status(400).json({
                error: "categoryId, sizeId hoặc colorId không tồn tại!"
            });
        }

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Có biến thể bị trùng size và màu!"
            });
        }

        return res.status(500).json({
            error: error.message || "Không thể sửa sản phẩm!"
        });

    } finally {
        if (connection) connection.release();
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC XÓA SẢN PHẨM
// =========================================================================
app.delete('/api/products/:productId', authMiddleware, adminMiddleware, async (req, res) => {
    const { productId } = req.params;

    let connection;
    let imageKeysToDelete = [];

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `
            SELECT product_id, image_key
            FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                error: "Không tìm thấy sản phẩm cần xóa!"
            });
        }

        const product = rows[0];

        if (product.image_key) {
            imageKeysToDelete.push(product.image_key);
        }

        const [imageRows] = await connection.execute(
            `
            SELECT image_key
            FROM product_images
            WHERE product_id = ?
            `,
            [productId]
        );

        imageKeysToDelete = imageKeysToDelete.concat(
            imageRows
                .map(row => row.image_key)
                .filter(Boolean)
        );

        await connection.execute(
            `
            DELETE FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        await connection.commit();

        for (const imageKey of imageKeysToDelete) {
            await deleteImageFromS3(imageKey);
        }

        return res.json({
            message: "Admin đã xóa sản phẩm thành công!"
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }

        console.error("Lỗi xóa sản phẩm:", error);

        return res.status(500).json({
            error: error.message || "Không thể xóa sản phẩm!"
        });

    } finally {
        if (connection) connection.release();
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC TẠO DANH MỤC
// =========================================================================    
app.post('/api/categories', authMiddleware, adminMiddleware, async (req, res) => {
    const { categoryName } = req.body || {};

    if (!categoryName || !categoryName.trim()) {
        return res.status(400).json({
            error: "Tên danh mục không được để trống!"
        });
    }

    try {
        const [result] = await dbPool.execute(
            `
            INSERT INTO categories (category_name)
            VALUES (?)
            `,
            [categoryName.trim()]
        );

        return res.status(201).json({
            message: "Admin đã tạo danh mục thành công!",
            categoryId: result.insertId
        });

    } catch (error) {
        console.error("Lỗi tạo category:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Danh mục này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể tạo danh mục!"
        });
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC SỬA DANH MỤC
// =========================================================================
app.put('/api/categories/:categoryId', authMiddleware, adminMiddleware, async (req, res) => {
    const { categoryId } = req.params;
    const { categoryName } = req.body || {};

    if (!categoryName || !categoryName.trim()) {
        return res.status(400).json({
            error: "Tên danh mục không được để trống!"
        });
    }

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT category_id
            FROM categories
            WHERE category_id = ?
            `,
            [categoryId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy danh mục cần sửa!"
            });
        }

        await dbPool.execute(
            `
            UPDATE categories
            SET category_name = ?
            WHERE category_id = ?
            `,
            [categoryName.trim(), categoryId]
        );

        return res.json({
            message: "Admin đã cập nhật danh mục thành công!"
        });

    } catch (error) {
        console.error("Lỗi sửa category:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Tên danh mục này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể sửa danh mục!"
        });
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC XÓA DANH MỤC
// =========================================================================    
app.delete('/api/categories/:categoryId', authMiddleware, adminMiddleware, async (req, res) => {
    const { categoryId } = req.params;

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT category_id, category_name
            FROM categories
            WHERE category_id = ?
            `,
            [categoryId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy danh mục cần xóa!"
            });
        }

        await dbPool.execute(
            `
            DELETE FROM categories
            WHERE category_id = ?
            `,
            [categoryId]
        );

        return res.json({
            message: "Admin đã xóa danh mục thành công! Các sản phẩm thuộc danh mục này sẽ chuyển về Chưa phân loại."
        });

    } catch (error) {
        console.error("Lỗi xóa category:", error);
        return res.status(500).json({
            error: "Không thể xóa danh mục!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN TẠO SIZE
// =========================================================================
app.post('/api/sizes', authMiddleware, adminMiddleware, async (req, res) => {
    const { sizeName, displayOrder } = req.body || {};

    if (!sizeName || !String(sizeName).trim()) {
        return res.status(400).json({
            error: "Tên size không được để trống!"
        });
    }

    const cleanSizeName = String(sizeName).trim().toUpperCase();
    let cleanDisplayOrder = parseOptionalDisplayOrder(displayOrder);

    try {
        if (cleanDisplayOrder === null) {
            const [orderRows] = await dbPool.execute(
                `
                SELECT COALESCE(MAX(display_order), 0) + 1 AS next_display_order
                FROM sizes
                `
            );

            cleanDisplayOrder = orderRows[0].next_display_order || 1;
        }

        const [result] = await dbPool.execute(
            `
            INSERT INTO sizes (
                size_name,
                display_order
            )
            VALUES (?, ?)
            `,
            [cleanSizeName, cleanDisplayOrder]
        );

        return res.status(201).json({
            message: "Admin đã tạo size thành công!",
            sizeId: result.insertId
        });

    } catch (error) {
        console.error("Lỗi tạo size:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Size này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể tạo size!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN SỬA SIZE
// =========================================================================
app.put('/api/sizes/:sizeId', authMiddleware, adminMiddleware, async (req, res) => {
    const { sizeId } = req.params;
    const { sizeName, displayOrder } = req.body || {};

    if (!sizeName || !String(sizeName).trim()) {
        return res.status(400).json({
            error: "Tên size không được để trống!"
        });
    }

    const cleanSizeName = String(sizeName).trim().toUpperCase();
    const cleanDisplayOrder = parseOptionalDisplayOrder(displayOrder);

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT size_id
            FROM sizes
            WHERE size_id = ?
            `,
            [sizeId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy size cần sửa!"
            });
        }

        if (cleanDisplayOrder === null) {
            await dbPool.execute(
                `
                UPDATE sizes
                SET size_name = ?
                WHERE size_id = ?
                `,
                [cleanSizeName, sizeId]
            );
        } else {
            await dbPool.execute(
                `
                UPDATE sizes
                SET
                    size_name = ?,
                    display_order = ?
                WHERE size_id = ?
                `,
                [cleanSizeName, cleanDisplayOrder, sizeId]
            );
        }

        return res.json({
            message: "Admin đã cập nhật size thành công!"
        });

    } catch (error) {
        console.error("Lỗi sửa size:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Tên size này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể sửa size!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN XÓA SIZE
// =========================================================================
app.delete('/api/sizes/:sizeId', authMiddleware, adminMiddleware, async (req, res) => {
    const { sizeId } = req.params;

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT size_id, size_name
            FROM sizes
            WHERE size_id = ?
            `,
            [sizeId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy size cần xóa!"
            });
        }

        const [usedRows] = await dbPool.execute(
            `
            SELECT COUNT(*) AS used_count
            FROM product_variants
            WHERE size_id = ?
            `,
            [sizeId]
        );

        if (Number(usedRows[0].used_count) > 0) {
            return res.status(400).json({
                error: "Không thể xóa size này vì đang được dùng bởi biến thể sản phẩm."
            });
        }

        await dbPool.execute(
            `
            DELETE FROM sizes
            WHERE size_id = ?
            `,
            [sizeId]
        );

        return res.json({
            message: "Admin đã xóa size thành công!"
        });

    } catch (error) {
        console.error("Lỗi xóa size:", error);

        return res.status(500).json({
            error: "Không thể xóa size!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN TẠO MÀU
// =========================================================================
app.post('/api/colors', authMiddleware, adminMiddleware, async (req, res) => {
    const { colorName, colorCode, displayOrder } = req.body || {};

    if (!colorName || !String(colorName).trim()) {
        return res.status(400).json({
            error: "Tên màu không được để trống!"
        });
    }

    const cleanColorName = String(colorName).trim();
    let cleanColorCode;

    try {
        cleanColorCode = normalizeColorCode(colorCode);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let cleanDisplayOrder = parseOptionalDisplayOrder(displayOrder);

    try {
        if (cleanDisplayOrder === null) {
            const [orderRows] = await dbPool.execute(
                `
                SELECT COALESCE(MAX(display_order), 0) + 1 AS next_display_order
                FROM colors
                `
            );

            cleanDisplayOrder = orderRows[0].next_display_order || 1;
        }

        const [result] = await dbPool.execute(
            `
            INSERT INTO colors (
                color_name,
                color_code,
                display_order
            )
            VALUES (?, ?, ?)
            `,
            [
                cleanColorName,
                cleanColorCode === undefined ? null : cleanColorCode,
                cleanDisplayOrder
            ]
        );

        return res.status(201).json({
            message: "Admin đã tạo màu thành công!",
            colorId: result.insertId
        });

    } catch (error) {
        console.error("Lỗi tạo color:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Màu này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể tạo màu!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN SỬA MÀU
// =========================================================================
app.put('/api/colors/:colorId', authMiddleware, adminMiddleware, async (req, res) => {
    const { colorId } = req.params;
    const { colorName, colorCode, displayOrder } = req.body || {};

    if (!colorName || !String(colorName).trim()) {
        return res.status(400).json({
            error: "Tên màu không được để trống!"
        });
    }

    const cleanColorName = String(colorName).trim();
    let cleanColorCode;

    try {
        cleanColorCode = normalizeColorCode(colorCode);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    const cleanDisplayOrder = parseOptionalDisplayOrder(displayOrder);

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT color_id
            FROM colors
            WHERE color_id = ?
            `,
            [colorId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy màu cần sửa!"
            });
        }

        const updateFields = ["color_name = ?"];
        const params = [cleanColorName];

        if (cleanColorCode !== undefined) {
            updateFields.push("color_code = ?");
            params.push(cleanColorCode);
        }

        if (cleanDisplayOrder !== null) {
            updateFields.push("display_order = ?");
            params.push(cleanDisplayOrder);
        }

        params.push(colorId);

        await dbPool.execute(
            `
            UPDATE colors
            SET ${updateFields.join(", ")}
            WHERE color_id = ?
            `,
            params
        );

        return res.json({
            message: "Admin đã cập nhật màu thành công!"
        });

    } catch (error) {
        console.error("Lỗi sửa color:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                error: "Tên màu này đã tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể sửa màu!"
        });
    }
});

// =========================================================================
// ROUTE BẢO MẬT: ADMIN XÓA MÀU
// =========================================================================
app.delete('/api/colors/:colorId', authMiddleware, adminMiddleware, async (req, res) => {
    const { colorId } = req.params;

    try {
        const [rows] = await dbPool.execute(
            `
            SELECT color_id, color_name
            FROM colors
            WHERE color_id = ?
            `,
            [colorId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy màu cần xóa!"
            });
        }

        const [usedRows] = await dbPool.execute(
            `
            SELECT COUNT(*) AS used_count
            FROM product_variants
            WHERE color_id = ?
            `,
            [colorId]
        );

        if (Number(usedRows[0].used_count) > 0) {
            return res.status(400).json({
                error: "Không thể xóa màu này vì đang được dùng bởi biến thể sản phẩm."
            });
        }

        await dbPool.execute(
            `
            DELETE FROM colors
            WHERE color_id = ?
            `,
            [colorId]
        );

        return res.json({
            message: "Admin đã xóa màu thành công!"
        });

    } catch (error) {
        console.error("Lỗi xóa color:", error);

        return res.status(500).json({
            error: "Không thể xóa màu!"
        });
    }
});

// Khởi chạy Product Service ở cổng 3001
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Product Service running on port ${PORT}`);
});