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
                p.price,
                p.stock_quantity,
                p.image_key,
                p.created_at,
                p.updated_at,
                c.category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.category_id
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
        categoryId,
        price,
        stockQuantity,
        imageKey
    } = req.body || {};

    if (!productName || price === undefined || stockQuantity === undefined) {
        return res.status(400).json({
            error: "Vui lòng nhập đầy đủ tên sản phẩm, giá tiền và số lượng kho!"
        });
    }

    if (Number(price) <= 0) {
        return res.status(400).json({
            error: "Giá sản phẩm phải lớn hơn 0!"
        });
    }

    if (Number(stockQuantity) < 0) {
        return res.status(400).json({
            error: "Số lượng kho không được nhỏ hơn 0!"
        });
    }

    if (imageKey && !imageKey.startsWith("products/")) {
        return res.status(400).json({
            error: "imageKey không hợp lệ!"
        });
    }

    try {
        const [result] = await dbPool.execute(
            `
            INSERT INTO products (
                product_name,
                category_id,
                price,
                stock_quantity,
                image_key
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
                productName.trim(),
                categoryId || null,
                price,
                stockQuantity,
                imageKey || null
            ]
        );

        return res.status(201).json({
            message: "Admin đã tạo sản phẩm mới thành công!",
            productId: result.insertId,
            imageUrl: buildImageUrl(imageKey)
        });

    } catch (error) {
        console.error("Lỗi tạo sản phẩm:", error);

        if (error.code === "ER_NO_REFERENCED_ROW_2") {
            return res.status(400).json({
                error: "categoryId không tồn tại!"
            });
        }

        return res.status(500).json({
            error: "Không thể tạo sản phẩm, lỗi hệ thống!"
        });
    }
});
// =========================================================================
// ROUTE BẢO MẬT: CHỈ ADMIN MỚI ĐƯỢC SỬA SẢN PHẨM
// =========================================================================
app.put('/api/products/:productId', authMiddleware, adminMiddleware, async (req, res) => {
    const { productId } = req.params;

    const {
        productName,
        categoryId,
        price,
        stockQuantity,
        imageKey
    } = req.body || {};

    let connection;

    try {
        connection = await dbPool.getConnection();

        const [rows] = await connection.execute(
            `
            SELECT
                product_id,
                product_name,
                category_id,
                price,
                stock_quantity,
                image_key
            FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy sản phẩm cần sửa!"
            });
        }

        const currentProduct = rows[0];

        const nextProductName =
            productName !== undefined ? productName.trim() : currentProduct.product_name;

        const nextCategoryId =
            categoryId !== undefined && categoryId !== null && categoryId !== ""
                ? Number(categoryId)
                : null;

        const nextPrice =
            price !== undefined ? Number(price) : Number(currentProduct.price);

        const nextStockQuantity =
            stockQuantity !== undefined ? Number(stockQuantity) : Number(currentProduct.stock_quantity);

        const nextImageKey =
            imageKey !== undefined ? imageKey : currentProduct.image_key;

        if (!nextProductName) {
            return res.status(400).json({
                error: "Tên sản phẩm không được để trống!"
            });
        }

        if (Number.isNaN(nextPrice) || nextPrice <= 0) {
            return res.status(400).json({
                error: "Giá sản phẩm phải lớn hơn 0!"
            });
        }

        if (Number.isNaN(nextStockQuantity) || nextStockQuantity < 0) {
            return res.status(400).json({
                error: "Số lượng kho không được nhỏ hơn 0!"
            });
        }

        if (nextImageKey && !nextImageKey.startsWith("products/")) {
            return res.status(400).json({
                error: "imageKey không hợp lệ!"
            });
        }

        await connection.execute(
            `
            UPDATE products
            SET
                product_name = ?,
                category_id = ?,
                price = ?,
                stock_quantity = ?,
                image_key = ?
            WHERE product_id = ?
            `,
            [
                nextProductName,
                nextCategoryId,
                nextPrice,
                nextStockQuantity,
                nextImageKey || null,
                productId
            ]
        );

        // Nếu admin đổi sang ảnh mới thì xóa ảnh cũ khỏi S3
        if (
            currentProduct.image_key &&
            nextImageKey &&
            currentProduct.image_key !== nextImageKey
        ) {
            await deleteImageFromS3(currentProduct.image_key);
        }

        const [updatedRows] = await connection.execute(
            `
            SELECT
                p.product_id,
                p.product_name,
                p.category_id,
                p.price,
                p.stock_quantity,
                p.image_key,
                p.created_at,
                p.updated_at,
                c.category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.category_id
            WHERE p.product_id = ?
            `,
            [productId]
        );

        const updatedProduct = updatedRows[0];

        return res.json({
            message: "Admin đã cập nhật sản phẩm thành công!",
            product: {
                ...updatedProduct,
                imageUrl: buildImageUrl(updatedProduct.image_key)
            }
        });

    } catch (error) {
        console.error("Lỗi sửa sản phẩm:", error);

        if (error.code === "ER_NO_REFERENCED_ROW_2") {
            return res.status(400).json({
                error: "categoryId không tồn tại!"
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

    try {
        connection = await dbPool.getConnection();

        const [rows] = await connection.execute(
            `
            SELECT product_id, image_key
            FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy sản phẩm cần xóa!"
            });
        }

        const product = rows[0];

        await connection.execute(
            `
            DELETE FROM products
            WHERE product_id = ?
            `,
            [productId]
        );

        // Xóa object ảnh khỏi S3 nếu có
        if (product.image_key) {
            await deleteImageFromS3(product.image_key);
        }

        return res.json({
            message: "Admin đã xóa sản phẩm thành công!"
        });

    } catch (error) {
        console.error("Lỗi xóa sản phẩm:", error);

        return res.status(500).json({
            error: error.message || "Không thể xóa sản phẩm!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// Khởi chạy Product Service ở cổng 3001
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Product Service running on port ${PORT}`);
});