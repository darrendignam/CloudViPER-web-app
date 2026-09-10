FROM node:22-alpine3.19

# Set the working directory
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY ./web-app/package*.json ./
COPY ./web-app/tsconfig.json ./
COPY ./web-app/gulpfile.js ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY ./web-app/src/ ./src/
COPY ./web-app/scripts/ ./scripts/

# Instance provisioning scripts, read at runtime by utility/scriptManager. They
# live at the repository root because the VM build uses them too; without this
# copy the monitor is never installed into a ViPER instance.
COPY ./scripts/viper-monitor.sh ./scripts/viper-monitor.sh
COPY ./scripts/viper-monitor.desktop ./scripts/viper-monitor.desktop

# Build the TypeScript application
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Expose the port
EXPOSE 3000

# Start the application
CMD [ "node", "dist/app.js" ]