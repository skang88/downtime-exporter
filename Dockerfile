# 1. Base Image: Use a lightweight Node.js image
FROM node:18-alpine

# 2. Create and set the working directory
WORKDIR /usr/src/app

# 3. Copy package.json and package-lock.json for dependency installation
# This leverages Docker's layer caching.
COPY package*.json ./

# 4. Install production dependencies
RUN npm install --production

# 5. Copy the rest of the application source code
COPY . .

# 6. Expose the application port
EXPOSE 8002

# 7. Define the command to run the application
CMD [ "node", "index.js" ]
