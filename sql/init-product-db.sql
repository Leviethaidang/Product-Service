CREATE DATABASE IF NOT EXISTS ecommerce_product_db;
USE ecommerce_product_db;

CREATE TABLE IF NOT EXISTS categories (
    category_id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(200) NOT NULL,
    description TEXT NULL,
    category_id INT,
    price DECIMAL(12, 2) NOT NULL,
    image_key VARCHAR(500),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sizes (
    size_id INT AUTO_INCREMENT PRIMARY KEY,
    size_name VARCHAR(20) NOT NULL UNIQUE,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS colors (
    color_id INT AUTO_INCREMENT PRIMARY KEY,
    color_name VARCHAR(100) NOT NULL UNIQUE,
    color_code VARCHAR(20) NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_images (
    image_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    image_key VARCHAR(500) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_variants (
    variant_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    size_id INT NOT NULL,
    color_id INT NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(size_id),
    FOREIGN KEY (color_id) REFERENCES colors(color_id),

    UNIQUE KEY unique_product_size_color (product_id, size_id, color_id)
);

INSERT IGNORE INTO sizes (size_name, display_order)
VALUES
('FREE', 0),
('S', 1),
('M', 2),
('L', 3),
('XL', 4),
('XXL', 5);

INSERT IGNORE INTO colors (color_name, color_code, display_order)
VALUES
('Mặc định', NULL, 0),
('Đen', '#000000', 1),
('Trắng', '#FFFFFF', 2),
('Xám', '#808080', 3),
('Xanh', '#0000FF', 4),
('Đỏ', '#FF0000', 5),
('Vàng', '#FFFF00', 6),
('Tím', '#800080', 7),
('Nâu', '#8B4513', 8),
('Be', '#F5F5DC', 9);