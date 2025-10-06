export function getImagePath(imageName) {
    return `/assets/pizzas/${imageName}.jpg`;
}

export function formatId(name) {
    return name.toLowerCase().replace(/ & /g, '-and-').replace(/ /g, '-');
}